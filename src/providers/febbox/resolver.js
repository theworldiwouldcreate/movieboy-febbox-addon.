'use strict';

const axios = require('axios');
const stringSimilarity = require('string-similarity');
const client = require('./client');
const {
  parseQualityListHtml,
  extractCodecDetails,
  sortStreamsByQuality,
  parseSizeToBytes,
  matchesEpisode,
} = require('./parser');
const { FebBoxError } = require('./types');
const { validateDirectUrl } = require('./urlValidate');

const PLAYBACK_MODE = { DIRECT: 'direct', EXPERIMENTAL_HLS: 'experimental-hls', BOTH: 'both' };
const DEFAULT_PLAYBACK_MODE = PLAYBACK_MODE.DIRECT;
const PLAYBACK_MODE_VALUES = new Set(Object.values(PLAYBACK_MODE));
const INCLUDES_DIRECT = new Set([PLAYBACK_MODE.DIRECT, PLAYBACK_MODE.BOTH]);
const INCLUDES_HLS = new Set([PLAYBACK_MODE.EXPERIMENTAL_HLS, PLAYBACK_MODE.BOTH]);

// Cache TTLs (ms)
const TTL_FOLDER_MS = 6 * 60 * 60 * 1000;        // 6 hours: root, year, series folders
const TTL_TITLE_MATCH_MS = 12 * 60 * 60 * 1000;  // 12 hours: resolved title -> folder/file
const TTL_MISSING_MS = 10 * 60 * 1000;           // 10 minutes: verified genuine NOT_FOUND

// Request pacing & traversal bounds
const REQUEST_SPACING_MS = 850;
const MAX_PAGES = 20;
const MAX_RECURSION_DEPTH = 3;
const MAX_CONTAINER_BRANCHES = 30; // Handles full A-Z + 0-9 folder structures
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Unified TTL Cache & Single-Flight Deduplicator
// ---------------------------------------------------------------------------
const ttlCache = new Map();
const inFlight = new Map();

function cacheGet(key) {
  const entry = ttlCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    ttlCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key, value, ttlMs) {
  if (ttlMs <= 0) return;
  ttlCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function singleFlight(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = (async () => {
    try {
      return await fn();
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Centralized FebBox Request Queue + Exponential Backoff
// ---------------------------------------------------------------------------
let requestChain = Promise.resolve();
let lastRequestAt = 0;

function isRateLimitSignal(err, data) {
  const status = err?.response?.status;
  if (status === 429 || status === 503) return true;
  if (err instanceof FebBoxError && err.code === 'RATE_LIMITED') return true;
  const msg = String(data?.msg || data?.message || err?.message || '').toLowerCase();
  return msg.includes('rate') || msg.includes('too many') || msg.includes('frequent') || msg.includes('limit');
}

function febboxRequest(fn, { retries = 3 } = {}) {
  const run = async () => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const wait = Math.max(0, REQUEST_SPACING_MS - (Date.now() - lastRequestAt));
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();

      try {
        const result = await fn();
        if (result && typeof result === 'object' && 'code' in result && result.code !== 1 && result.code !== 200) {
          if (isRateLimitSignal(null, result)) {
            throw new FebBoxError(result.msg || 'FebBox rate-limited this request', 'RATE_LIMITED');
          }
        }
        return result;
      } catch (err) {
        if (isRateLimitSignal(err, err?.response?.data)) {
          if (attempt < retries) {
            const backoffMs = 1500 * Math.pow(2, attempt) + Math.floor(Math.random() * 400);
            console.warn(`[MovieBoy] Rate-limited by FebBox (attempt ${attempt + 1}/${retries + 1}), backing off ${backoffMs}ms`);
            await sleep(backoffMs);
            continue;
          }
          throw new FebBoxError('FebBox rate-limited this request', 'RATE_LIMITED');
        }
        throw err;
      }
    }
    throw new FebBoxError('FebBox rate-limited this request', 'RATE_LIMITED');
  };

  const chained = requestChain.then(run, run);
  requestChain = chained.catch(() => {});
  return chained;
}

async function fetchSharePage({ token, shareKey, parentId = 0, page = 1, wd = '' }) {
  return febboxRequest(async () => {
    const params = { share_key: shareKey, parent_id: parentId, page };
    if (wd) params.wd = wd;

    const resp = await axios.get('https://www.febbox.com/file/file_share_list', {
      params,
      timeout: 15000,
      headers: {
        Cookie: `ui=${token}`,
        'User-Agent': USER_AGENT,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    const data = resp?.data;
    if (isRateLimitSignal(null, data)) {
      throw new FebBoxError(data?.msg || 'FebBox rate-limited this request', 'RATE_LIMITED');
    }

    const list = data?.data?.file_list;
    if (!Array.isArray(list)) return [];
    return list.map((item) => ({
      fid: String(item.fid),
      name: item.file_name || item.name || '',
      isDir: Boolean(item.is_dir),
      size: item.file_size || null,
    }));
  });
}

async function listFolderAllPages({ token, shareKey, parentId = 0 }) {
  const cacheKey = `folder:${shareKey}:${parentId}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  return singleFlight(cacheKey, async () => {
    const recheck = cacheGet(cacheKey);
    if (recheck !== undefined) return recheck;

    const all = [];
    const seenFids = new Set();

    for (let page = 1; page <= MAX_PAGES; page++) {
      const list = await fetchSharePage({ token, shareKey, parentId, page });
      if (list.length === 0) break;

      let addedThisPage = 0;
      for (const item of list) {
        if (seenFids.has(item.fid)) continue;
        seenFids.add(item.fid);
        all.push(item);
        addedThisPage++;
      }

      if (list.length < 50 || addedThisPage === 0) break;
    }

    // Only cache complete, non-empty listings (rate-limit errors throw above and bypass caching)
    if (all.length > 0) {
      cacheSet(cacheKey, all, TTL_FOLDER_MS);
    }
    return all;
  });
}

// ---------------------------------------------------------------------------
// Title Normalization & Matching Helpers
// ---------------------------------------------------------------------------
const RELEASE_TAG_RE =
  /\b(2160p|1080p|720p|480p|4k|uhd|hdr|hdr10|dv|dolby[\s._-]*vision|bluray|blu[\s._-]*ray|bdrip|brrip|web[\s._-]*dl|webrip|web|hdrip|dvdrip|remux|x264|x265|h[\s._-]*264|h[\s._-]*265|hevc|av1|aac\d*(?:\.\d)?|ac3|eac3|ddp?\d(?:\.\d)?|dts(?:-hd)?|truehd|atmos|10bit|8bit|proper|repack|extended|unrated|directors[\s._-]*cut|yts(?:\.[a-z]+)?|rarbg|yify|amzn|nf|dsnp|hmax|atvp)\b.*$/i;

function normalizeTitle(raw) {
  let s = String(raw || '')
    .replace(/\.[a-z0-9]{2,4}$/i, '') // strip file extension
    .replace(/[\[\(\{]\s*(?:19\d{2}|20\d{2})\s*[\]\)\}]/g, ' ') // strip bracketed years
    .replace(RELEASE_TAG_RE, ' '); // strip trailing scene/release tags

  s = s
    .replace(/\b(19\d{2}|20\d{2})\b\s*$/, ' ') // strip trailing unbracketed year
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  return s;
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

function buildTargetVariants(rawTitles) {
  const variants = new Set();
  for (const raw of rawTitles) {
    const norm = normalizeTitle(raw);
    if (!norm) continue;
    variants.add(norm);
    // Also add version without leading article ("The ", "A ", "An ")
    const strippedArticle = norm.replace(/^(the|a|an)\s+/, '');
    if (strippedArticle && strippedArticle !== norm) variants.add(strippedArticle);
  }
  return [...variants];
}

function matchBestEntry(entries, targetVariants, expectedYear = null) {
  let bestMatch = null;
  let bestScore = 0;

  for (const item of entries) {
    const normName = normalizeTitle(item.name);
    if (!normName) continue;
    const itemYear = extractYearFromName(item.name);

    for (const target of targetVariants) {
      let score = stringSimilarity.compareTwoStrings(target, normName);
      if (normName === target) score = 1.0;

      // Boost or penalize based on year alignment when both have years
      if (expectedYear && itemYear) {
        const diff = Math.abs(itemYear - Number(expectedYear));
        if (diff === 0) score += 0.06;
        else if (diff === 1) score += 0.02;
        else score -= 0.25;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = item;
      }
    }
  }
  return { bestMatch, bestScore };
}

// ---------------------------------------------------------------------------
// Bounded Recursive & Prioritized Mega-Share Discovery
// ---------------------------------------------------------------------------
async function searchShareByKeyword({ token, shareKey, query }) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];

  const cacheKey = `wd:${shareKey}:${cleanQuery.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  return singleFlight(cacheKey, async () => {
    const recheck = cacheGet(cacheKey);
    if (recheck !== undefined) return recheck;

    // Rate-limit errors intentionally propagate upward rather than returning []
    const hits = await fetchSharePage({ token, shareKey, parentId: 0, page: 1, wd: cleanQuery });
    if (hits.length > 0) {
      cacheSet(cacheKey, hits, TTL_FOLDER_MS);
    }
    return hits;
  });
}

async function boundedRecursiveSearch({
  token,
  shareKey,
  entries,
  targetVariants,
  year,
  depth = 0,
  visited = new Set(),
}) {
  // 1. Direct match at current directory level
  const direct = matchBestEntry(entries, targetVariants, year);
  if (direct.bestMatch && direct.bestScore >= 0.80) {
    return { shareKey, entry: direct.bestMatch };
  }

  if (depth >= MAX_RECURSION_DEPTH) return null;

  const dirs = entries.filter((e) => e.isDir && !visited.has(e.fid));
  if (dirs.length === 0) return null;

  // 2. Prioritize four-digit year directories (exact year -> +/-1 year -> remaining years)
  const yearDirs = [];
  const otherDirs = [];
  for (const d of dirs) {
    const y = extractYearFromName(d.name);
    if (y !== null && /^\s*(?:movies|tv|shows|series)?\s*[\(\[]?(19\d{2}|20\d{2})[\)\]]?\s*$/i.test(d.name)) {
      yearDirs.push({ dir: d, y });
    } else {
      otherDirs.push(d);
    }
  }

  if (yearDirs.length > 0) {
    const targetYear = year ? Number(year) : null;
    const prioritized = targetYear
      ? [
          ...yearDirs.filter((x) => x.y === targetYear),
          ...yearDirs.filter((x) => Math.abs(x.y - targetYear) === 1),
        ]
      : yearDirs.slice(0, 5);

    for (const { dir } of prioritized) {
      visited.add(dir.fid);
      const children = await listFolderAllPages({ token, shareKey, parentId: dir.fid });
      const res = matchBestEntry(children, targetVariants, year);
      if (res.bestMatch && res.bestScore >= 0.74) {
        return { shareKey, entry: res.bestMatch };
      }
    }
  }

  // 3. Alphabetical / bucket folders (supports full A-Z, 0-9, or range folders like "A-F")
  const primaryTitle = targetVariants[0] || '';
  const firstChar = primaryTitle[0] || '';
  const matchingAlphaDirs = otherDirs.filter((d) => {
    const label = String(d.name || '').trim().toLowerCase();
    if (!firstChar) return false;
    if (label === firstChar) return true;
    if (/[0-9]/.test(firstChar) && /^(0[\s-]*9|#)$/.test(label)) return true;
    const range = label.match(/^([a-z])\s*-\s*([a-z])$/);
    if (range && firstChar >= range[1] && firstChar <= range[2]) return true;
    return false;
  });

  for (const dir of matchingAlphaDirs) {
    visited.add(dir.fid);
    const children = await listFolderAllPages({ token, shareKey, parentId: dir.fid });
    const found = await boundedRecursiveSearch({
      token,
      shareKey,
      entries: children,
      targetVariants,
      year,
      depth: depth + 1,
      visited,
    });
    if (found) return found;
  }

  // 4. Bounded traversal of remaining container folders (e.g., "Movies", "4K", "TV Shows")
  const nonYearRemaining = otherDirs
    .filter((d) => !visited.has(d.fid) && d.name.length > 2)
    .slice(0, MAX_CONTAINER_BRANCHES);

  for (const dir of nonYearRemaining) {
    visited.add(dir.fid);
    const children = await listFolderAllPages({ token, shareKey, parentId: dir.fid });
    const found = await boundedRecursiveSearch({
      token,
      shareKey,
      entries: children,
      targetVariants,
      year,
      depth: depth + 1,
      visited,
    });
    if (found) return found;
  }

  return null;
}

async function findTitleInMegaShare({ token, shareKeys, title, year, altTitles = [] }) {
  const rawTitles = [title, ...altTitles].filter(Boolean);
  const targetVariants = buildTargetVariants(rawTitles);
  const discoveryKey = `discover:${shareKeys.join(',')}:${normalizeTitle(title)}:${year || ''}`;

  const cached = cacheGet(discoveryKey);
  if (cached !== undefined) {
    if (cached === null) {
      throw new FebBoxError(`Title "${title}" not found in MovieBoy share (cached miss)`, 'NOT_FOUND');
    }
    return cached;
  }

  return singleFlight(discoveryKey, async () => {
    const recheck = cacheGet(discoveryKey);
    if (recheck !== undefined) {
      if (recheck === null) {
        throw new FebBoxError(`Title "${title}" not found in MovieBoy share (cached miss)`, 'NOT_FOUND');
      }
      return recheck;
    }

    let searchFailedOrDegraded = false;

    for (const realShareKey of shareKeys) {
      // Phase 1: Server-side keyword search (fast path, 1 request)
      for (const q of rawTitles.slice(0, 2)) {
        try {
          const hits = await searchShareByKeyword({ token, shareKey: realShareKey, query: q });
          if (hits.length > 0) {
            const res = matchBestEntry(hits, targetVariants, year);
            if (res.bestMatch && res.bestScore >= 0.75) {
              const found = { shareKey: realShareKey, entry: res.bestMatch };
              cacheSet(discoveryKey, found, TTL_TITLE_MATCH_MS);
              return found;
            }
          }
        } catch (err) {
          if (err instanceof FebBoxError && err.code === 'RATE_LIMITED') throw err;
          searchFailedOrDegraded = true;
          console.warn(`[MovieBoy] Keyword search degraded for "${q}" in ${realShareKey}: ${err.message}`);
        }
      }

      // Phase 2: Bounded recursive folder search (Year -> Alpha -> Container)
      const rootEntries = await listFolderAllPages({ token, shareKey: realShareKey, parentId: 0 });
      if (rootEntries.length === 0) {
        searchFailedOrDegraded = true;
        continue;
      }

      const found = await boundedRecursiveSearch({
        token,
        shareKey: realShareKey,
        entries: rootEntries,
        targetVariants,
        year,
        depth: 0,
        visited: new Set(),
      });

      if (found) {
        cacheSet(discoveryKey, found, TTL_TITLE_MATCH_MS);
        return found;
      }

      console.info(
        `[MovieBoy] Title "${title}" (${year || 'n/a'}) absent after scanning share ${realShareKey} (${rootEntries.length} root entries)`
      );
    }

    if (searchFailedOrDegraded) {
      // Do NOT negative-cache when FebBox returned incomplete/errored responses
      throw new FebBoxError(`FebBox search incomplete for "${title}"`, 'SEARCH_FAILED');
    }

    // Genuine confirmed miss: cache for 10 minutes to prevent repeat crawls
    cacheSet(discoveryKey, null, TTL_MISSING_MS);
    throw new FebBoxError(`Title "${title}" not found in MovieBoy share`, 'NOT_FOUND');
  });
}

// ---------------------------------------------------------------------------
// File Listing & Stream Extraction
// ---------------------------------------------------------------------------
async function listAllFiles({ token, shareKey }, parentId = 0, depth = 0) {
  if (depth > MAX_RECURSION_DEPTH) return [];
  const entries = await listFolderAllPages({ token, shareKey, parentId });
  let all = [];
  for (const entry of entries) {
    if (entry.isDir) {
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
  const html = await febboxRequest(() => client.getVideoQualityLinks({ token, shareKey, fid }));
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
      const streams = await resolveFileStreams({
        token,
        shareKey: activeShareKey,
        fid: f.fid,
        fileName: f.name,
        playbackMode,
      });
      results.push(...streams);
    } catch (err) {
      if (err instanceof FebBoxError && err.code === 'RATE_LIMITED') throw err;
    }
  }
  return sortWithD
    return sortWithDirectFirst(results);
  async function collectEpisodeFiles({ token, shareKey, rootParentId, season }) {
  const targetSeason = Number(season);
  const top = rootParentId
    ? await listFolderAllPages({ token, shareKey, parentId: rootParentId })
    : await listTopLevel({ token, shareKey });

  const directVideos = top.filter((e) => !e.isDir && isLikelyVideo(e.name));
  const dirs = top.filter((e) => e.isDir);

  const matchingSeasonDirs = [];
  const otherSeasonDirs = [];
  const neutralDirs = [];

  for (const d of dirs) {
    const m = SEASON_FOLDER_RE.exec(d.name || '');
    if (m) {
      if (Number(m[1]) === targetSeason) matchingSeasonDirs.push(d);
      else otherSeasonDirs.push(d);
    } else {
      neutralDirs.push(d);
    }
  }

  if (matchingSeasonDirs.length > 0) {
    let files = [];
    for (const dir of matchingSeasonDirs) {
      // eslint-disable-next-line no-await-in-loop
      files = files.concat(await listAllFiles({ token, shareKey }, dir.fid, 1));
    }
    return files.filter((f) => isLikelyVideo(f.name));
  }

  for (const dir of neutralDirs.slice(0, 6)) {
    // eslint-disable-next-line no-await-in-loop
    const subEntries = await listFolderAllPages({ token, shareKey, parentId: dir.fid });
    const nestedSeason = subEntries.find((e) => {
      if (!e.isDir) return false;
      const m = SEASON_FOLDER_RE.exec(e.name || '');
      return m && Number(m[1]) === targetSeason;
    });
    if (nestedSeason) {
      return (await listAllFiles({ token, shareKey }, nestedSeason.fid, 2)).filter((f) =>
        isLikelyVideo(f.name)
      );
    }
  }

  let fallbackVideos = [...directVideos];
  if (otherSeasonDirs.length === 0) {
    for (const dir of neutralDirs.slice(0, 6)) {
      // eslint-disable-next-line no-await-in-loop
      const files = await listAllFiles({ token, shareKey }, dir.fid, 1);
      fallbackVideos = fallbackVideos.concat(files.filter((f) => isLikelyVideo(f.name)));
    }
  }
  return fallbackVideos;
}
}
async function resolveEpisode({ token, shareKey, season, episode, playbackMode = DEFAULT_PLAYBACK_MODE }) {
  let activeShareKey = shareKey;
  let seriesParentId = 0;

  const mb = decodeMovieBoyKey(shareKey);
  if (mb) {
    const found = await findTitleInMegaShare({ token, ...mb });
    activeShareKey = found.shareKey;
    seriesParentId = found.entry.fid;
  }

  const videoFiles = await collectEpisodeFiles({
    token,
    shareKey: activeShareKey,
    rootParentId: seriesParentId,
    season,
  });

  const matches = videoFiles.filter((f) => matchesEpisodeFlexible(f.name, season, episode));
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
      const streams = await resolveFileStreams({
        token,
        shareKey: activeShareKey,
        fid: f.fid,
        fileName: f.name,
        playbackMode,
      });
      results.push(...streams);
    } catch (err) {
      if (err instanceof FebBoxError && err.code === 'RATE_LIMITED') throw err;
    }
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
