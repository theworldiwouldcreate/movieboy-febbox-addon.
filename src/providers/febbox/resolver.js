'use strict';

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
const REQUEST_SPACING_MS = 250;
const FOLDER_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const folderCache = new Map(); // cacheKey -> { ts, entries }

function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/\(\d{4}\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function decodeMovieBoyKey(shareKey) {
  if (typeof shareKey !== 'string' || !shareKey.startsWith('MB::')) return null;
  try {
    return JSON.parse(Buffer.from(shareKey.slice(4), 'base64').toString('utf8'));
  } catch (err) {
    return null;
  }
}

async function listFolderCached({ token, shareKey, parentId = 0 }) {
  const key = `${shareKey}:${parentId}`;
  const cached = folderCache.get(key);
  if (cached && Date.now() - cached.ts < FOLDER_CACHE_TTL_MS) {
    return cached.entries;
  }
  const entries = await client.listShareFiles({ token, shareKey, parentId });
  folderCache.set(key, { ts: Date.now(), entries });
  return entries;
}

/**
 * Find a matching Series or Movie entry inside a Year -> Title FebBox share.
 * Only crawls the target year (±1 year) to stay fast on Render free tier.
 */
async function findTitleInMegaShare({ token, shareKeys, title, year, altTitles = [] }) {
  const targetTitles = [title, ...altTitles].filter(Boolean).map(normalizeTitle);

  for (const realShareKey of shareKeys) {
    const rootEntries = await listFolderCached({ token, shareKey: realShareKey, parentId: 0 });
    const yearFolders = rootEntries.filter((e) => e.isDir && /^\d{4}$/.test(String(e.name || '').trim()));

    // Prioritize exact year, then year - 1 and year + 1
    let candidateYears = yearFolders;
    if (year) {
      const targetYear = Number(year);
      candidateYears = yearFolders
        .filter((f) => Math.abs(Number(f.name.trim()) - targetYear) <= 1)
        .sort((a, b) => Math.abs(Number(a.name.trim()) - targetYear) - Math.abs(Number(b.name.trim()) - targetYear));
    }

    let bestMatch = null;
    let bestScore = 0;

    for (const yFolder of candidateYears) {
      // eslint-disable-next-line no-await-in-loop
      const items = await listFolderCached({ token, shareKey: realShareKey, parentId: yFolder.fid });
      for (const item of items) {
        const normName = normalizeTitle(item.name);
        if (!normName) continue;
        for (const t of targetTitles) {
          const score = stringSimilarity.compareTwoStrings(t, normName);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = { shareKey: realShareKey, entry: item };
          }
        }
      }
      if (bestScore >= 0.92) break; // strong match found, no need to check other years
    }

    if (bestMatch && bestScore >= 0.72) {
      return bestMatch;
    }
  }
  return null;
}

async function listAllFiles({ token, shareKey }, parentId = 0, depth = 0) {
  if (depth > MAX_RECURSION_DEPTH) return [];
  const entries = await client.listShareFiles({ token, shareKey, parentId });
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
  return client.listShareFiles({ token, shareKey, parentId: 0 });
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
    ? await listFolderCached({ token, shareKey: activeShareKey, parentId: seriesParentId })
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
  if (matches.length === 0) {
    throw new FebBoxError(
      `No files matching S${season}E${episode} found in this FebBox share`,
      'NOT_FOUND'
    );
  }

  const results = [];
  for (const f of matches) {
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

function isLikelyVideo(name) {
  return /\.(mp4|mkv|avi|mov|webm|m3u8|ts)$/i.test(String(name || ''));
}

function extractShareKey(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  const m = trimmed.match(/febbox\.com\/share\/([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{4,40}$/.test(trimmed)) return trimmed;
  return null;
}

module.exports = {
  resolveMovie,
  resolveEpisode,
  resolveFileStreams,
  listAllFiles,
  extractShareKey,
  isLikelyVideo,
  isHlsUrl,
  sortWithDirectFirst,
  PLAYBACK_MODE,
  DEFAULT_PLAYBACK_MODE,
  PLAYBACK_MODE_VALUES,
};
