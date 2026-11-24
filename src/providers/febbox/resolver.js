'use strict';

const axios = require('axios');
const stringSimilarity = require('string-similarity');
const client = require('./client');
const { parseQualityListHtml, extractCodecDetails, sortStreamsByQuality, parseSizeToBytes, matchesEpisode } = require('./parser');
const { FebBoxError } = require('./types');
const { validateDirectUrl } = require('./urlValidate');

const PLAYBACK_MODE = { DIRECT: 'direct', EXPERIMENTAL_HLS: 'experimental-hls', BOTH: 'both' };
const DEFAULT_PLAYBACK_MODE = PLAYBACK_MODE.DIRECT;
const PLAYBACK_MODE_VALUES = new Set(Object.values(PLAYBACK_MODE));
const INCLUDES_DIRECT = new Set([PLAYBACK_MODE.DIRECT, PLAYBACK_MODE.BOTH]);
const INCLUDES_HLS = new Set([PLAYBACK_MODE.EXPERIMENTAL_HLS, PLAYBACK_MODE.BOTH]);

const MAX_RECURSION_DEPTH = 4;
const REQUEST_SPACING_MS = 200;
const FOLDER_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_PAGES = 25; // up to 1,250 items per folder
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const folderCache = new Map();

function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/\(\d{4}\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function extractYearFromName(name) {
  const m = String(name || '').match(/\b(19\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

function decodeMovieBoyKey(shareKey) {
  if (typeof shareKey !== 'string' || !shareKey.startsWith('MB::')) return null;
  try {
    return JSON.parse(Buffer.from(shareKey.slice(4), 'base64').toString('utf8'));
  } catch (err) {
    return null;
  }
}

/**
 * Paginated FebBox folder listing (fetches page 1, 2, 3... so folders past
 * the first 50 items — like 2000s/2020s years or large year folders — are found).
 */
async function listFolderAllPages({ token, shareKey, parentId = 0 }) {
  const key = `${shareKey}:${parentId}`;
  const cached = folderCache.get(key);
  if (cached && Date.now() - cached.ts < FOLDER_CACHE_TTL_MS) {
    return cached.entries;
  }

  const all = [];
  const seenFids = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const resp = await axios.get('https://www.febbox.com/file/file_share_list', {
        params: { share_key: shareKey, parent_id: parentId, page },
        timeout: 15000,
        headers: {
          Cookie: `ui=${token}`,
          'User-Agent': USER_AGENT,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      const list = resp?.data?.data?.file_list;
      if (!Array.isArray(list) || list.length === 0) break;

      let addedThisPage = 0;
      for (const item of list) {
        const fid = String(item.fid);
        if (seenFids.has(fid)) continue;
        seenFids.add(fid);
        all.push({
          fid,
          name: item.file_name || item.name || '',
          isDir: Boolean(item.is_dir),
          size: item.file_size || null,
        });
        addedThisPage++;
      }

      if (list.length < 50 || addedThisPage === 0) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(150);
    } catch (err) {
      if (page === 1) {
        // Fallback to built-in client on page 1 error
        const fallback = await client.listShareFiles({ token, shareKey, parentId });
        folderCache.set(key, { ts: Date.now(), entries: fallback });
        return fallback;
      }
      break;
    }
  }

  folderCache.set(key, { ts: Date.now(), entries: all });
  return all;
}

function matchBestEntry(entries, targetTitles) {
  let bestMatch = null;
  let bestScore = 0;
  for (const item of entries) {
    const normName = normalizeTitle(item.name);
    if (!normName) continue;
    for (const t of targetTitles) {
      const score = stringSimilarity.compareTwoStrings(t, normName);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = item;
      }
    }
  }
  return { bestMatch, bestScore };
}

async function searchLevel({ token, shareKey, entries, targetTitles, year, depth = 0 }) {
  const direct = matchBestEntry(entries, targetTitles);
  if (direct.bestMatch && direct.bestScore >= 0.80) {
    return { shareKey, entry: direct.bestMatch };
  }

  const dirs = entries.filter((e) => e.isDir);

  const yearFolders = dirs
    .map((d) => ({ dir: d, y: extractYearFromName(d.name) }))
    .filter((x) => x.y !== null);

  if (yearFolders.length > 0) {
    let candidates = yearFolders;
    if (year) {
      const targetYear = Number(year);
      candidates = yearFolders
        .filter((x) => Math.abs(x.y - targetYear) <= 1)
        .sort((a, b) => Math.abs(a.y - targetYear) - Math.abs(b.y - targetYear));
    }

    let bestMatch = null;
    let bestScore = 0;
    for (const { dir } of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const items = await listFolderAllPages({ token, shareKey, parentId: dir.fid });
      const res = matchBestEntry(items, targetTitles);
      if (res.bestScore > bestScore) {
        bestScore = res.bestScore;
        bestMatch = res.bestMatch;
      }
      if (bestScore >= 0.90) break;
    }
    if (bestMatch && bestScore >= 0.72) {
      return { shareKey, entry: bestMatch };
    }
  }

  const firstChar = (targetTitles[0] || '')[0] || '';
  const alphaFolder = dirs.find((d) => {
    const n = String(d.name || '').trim().toLowerCase();
    return n === firstChar || (/[0-9]/.test(firstChar) && /^0[\s-]*9$/.test(n));
  });
  if (alphaFolder) {
    const items = await listFolderAllPages({ token, shareKey, parentId: alphaFolder.fid });
    const res = matchBestEntry(items, targetTitles);
    if (res.bestMatch && res.bestScore >= 0.72) {
      return { shareKey, entry: res.bestMatch };
    }
  }

  if (depth === 0 && dirs.length > 0 && dirs.length <= 10) {
    for (const dir of dirs) {
      // eslint-disable-next-line no-await-in-loop
      const subEntries = await listFolderAllPages({ token, shareKey, parentId: dir.fid });
      // eslint-disable-next-line no-await-in-loop
      const found = await searchLevel({ token, shareKey, entries: subEntries, targetTitles, year, depth: 1 });
      if (found) return found;
    }
  }

  return null;
}

async function findTitleInMegaShare({ token, shareKeys, title, year, altTitles = [] }) {
  const targetTitles = [title, ...altTitles].filter(Boolean).map(normalizeTitle);

  for (const realShareKey of shareKeys) {
    const rootEntries = await listFolderAllPages({ token, shareKey: realShareKey, parentId: 0 });
    const found = await searchLevel({
      token,
      shareKey: realShareKey,
      entries: rootEntries,
      targetTitles,
      year,
      depth: 0,
    });
    if (found) return found;

    console.log(
      `[MovieBoy] Missed "${title}" (${year}) in share ${realShareKey}. Total root entries: ${rootEntries.length}`
    );
  }
  return null;
}

async function listAllFiles({ token, shareKey }, parentId = 0, depth = 0) {
  if (depth > MAX_RECURSION_DEPTH) return [];
  const entries = await listFolderAllPages({ token, shareKey, parentId });
  let all = [];
  for (const entry of entries) {
    if (entry.isDir) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(REQUEST_SPACING_MS);
      // eslint-disable-next-line no-await-in-loop
      all = all.concat(await listAllFiles({ token, shareKey }, entry.fid, depth + 1));
    } else {
      all.push(entry);
    }
  }
  return all;
}

async function listTopLevel({ token, shareKey }) {
  return listFolderAllPages({ token, shareKey, parentId: 0 });
}

function isHlsUrl(url) {
  return /\.m3u8(\?|$)/i.test(url || '');
}

function toStream(l, fileName, { isHls }) {
  const sizeBytes = parseSizeToBytes(l.size);
  return {
    url: l.url,
    quality: l.quality,
    size: l.size,
    videoSizeBytes: Number.isFinite(sizeBytes) && sizeBytes < Number.MAX_SAFE_INTEGER ? sizeBytes : undefined,
    codecs: extractCodecDetails(fileName || l.name || ''),
    filename: fileName || l.name || 'video',
    provider: 'MovieBoy',
    isHls,
  };
}

function sortWithDirectFirst(streams) {
  const direct = sortStreamsByQuality(streams.filter((s) => !s.isHls));
  const hls = sortStreamsByQuality(streams.filter((s) => s.isHls));
  return [...direct, ...hls];
}

async function resolveFileStreams({ token, shareKey, fid, fileName, playbackMode = DEFAULT_PLAYBACK_MODE }) {
  const html = await client.getVideoQualityLinks({ token, shareKey, fid });
  const allLinks = parseQualityListHtml(html);
  const directCandidates = allLinks.filter((l) => !isHlsUrl(l.url));
  const hlsCandidates = allLinks.filter((l) => isHlsUrl(l.url));

  const streams = [];
  if (INCLUDES_DIRECT.has(playbackMode)) {
    for (const l of directCandidates) {
      // eslint-disable-next-line no-await-in-loop
      const check = await validateDirectUrl(l.url);
      if (check.valid) streams.push(toStream(l, fileName, { isHls: false }));
    }
  }

  if (INCLUDES_HLS.has(playbackMode)) {
    for (const l of hlsCandidates) {
      streams.push(toStream(l, fileName, { isHls: true }));
    }
  }

  if (streams.length === 0) {
    throw new FebBoxError('No playable sources returned for this file', 'NOT_FOUND');
  }
  return sortWithDirectFirst(streams);
}

async function resolveMovie({ token, shareKey, playbackMode = DEFAULT_PLAYBACK_MODE }) {
  let activeShareKey = shareKey;
  let videoFiles = [];

  const mb = decodeMovieBoyKey(shareKey);
  if (mb) {
    const found = await findTitleInMegaShare({ token, ...mb });
    if (!found) {
      throw new FebBoxError(`Movie "${mb.title}" not found in MovieBoy share`, 'NOT_FOUND');
    }
    activeShareKey = found.shareKey;
    if (found.entry.isDir) {
      const files = await listAllFiles({ token, shareKey: activeShareKey }, found.entry.fid, 1);
      videoFiles = files.filter((f) => isLikelyVideo(f.name));
    } else if (isLikelyVideo(found.entry.name)) {
      videoFiles = [found.entry];
    }
  } else {
    const files = await listAllFiles({ token, shareKey: activeShareKey });
    videoFiles = files.filter((f) => isLikelyVideo(f.name));
  }

  if (videoFiles.length === 0) {
    throw new FebBoxError('No video files found in this FebBox share', 'NOT_FOUND');
  }

  const results = [];
  for (const f of videoFiles) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const streams = await resolveFileStreams({ token, shareKey: activeShareKey, fid: f.fid, fileName: f.name, playbackMode });
      results.push(...streams);
    } catch (err) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(REQUEST_SPACING_MS);
  }
  return sortWithDirectFirst(results);
}

const SEASON_FOLDER_RE = /season[^0-9]{0,3}0*(\d+)\b/i;

async function resolveEpisode({ token, shareKey, season, episode, playbackMode = DEFAULT_PLAYBACK_MODE }) {
  let activeShareKey = shareKey;
  let seriesParentId = 0;

  const mb = decodeMovieBoyKey(shareKey);
  if (mb) {
    const found = await findTitleInMegaShare({ token, ...mb });
    if (!found) {
      throw new FebBoxError(`Series "${mb.title}" not found in MovieBoy share`, 'NOT_FOUND');
    }
    activeShareKey = found.shareKey;
    seriesParentId = found.entry.fid;
  }

  const top = seriesParentId
    ? await listFolderAllPages({ token, shareKey: activeShareKey, parentId: seriesParentId })
    : await listTopLevel({ token, shareKey: activeShareKey });

  const seasonFolder = top.find((e) => {
    if (!e.isDir) return false;
    const m = SEASON_FOLDER_RE.exec(e.name || '');
    return m && Number(m[1]) === Number(season);
  });

  let videoFiles;
  if (seasonFolder) {
    const files = await listAllFiles({ token, shareKey: activeShareKey }, seasonFolder.fid, 1);
    videoFiles = files.filter((f) => isLikelyVideo(f.name));
  } else {
    const files = await listAllFiles({ token, shareKey: activeShareKey }, seriesParentId, 1);
    videoFiles = files.filter((f) => isLikelyVideo(f.name));
  }

  const matches = videoFiles.filter((f) => matchesEpisode(f.name, season, episode));
  if (matches.length ===
