'use strict';

const stringSimilarity = require('string-similarity');
const { incrementCounter, METRIC } = require('../../metrics/metrics');

const BOX_TYPE = { movie: 1, tv: 2 };

function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/\(\d{4}\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function computeMatchScore(candidateTitle, candidateYear, { title, year }) {
  const targetTitle = normalizeTitle(title);
  const normCandidate = normalizeTitle(candidateTitle);
  if (!normCandidate) return 0;
  let score = stringSimilarity.compareTwoStrings(targetTitle, normCandidate);
  if (year && candidateYear) {
    const diff = Math.abs(Number(candidateYear) - Number(year));
    if (diff === 0) score += 0.15;
    else if (diff === 1) score -= 0.05;
    else score -= 0.35;
  }
  return score;
}

/**
 * Encodes the MovieBoy permanent share key(s) and TMDB title/year into a
 * payload that resolver.js decodes and resolves inside FebBox.
 */
async function resolveShareKeyForTitle(tmdbInfo) {
  if (!tmdbInfo || !tmdbInfo.title) return null;

  const isTv = tmdbInfo.tmdbType === 'tv';
  const rawKeys = isTv
    ? (process.env.MOVIEBOY_SERIES_SHARES || 'oOxgRSA6')
    : (process.env.MOVIEBOY_MOVIE_SHARES || 'DrNePquf');

  const shareKeys = rawKeys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  if (shareKeys.length === 0) {
    incrementCounter(METRIC.DISCOVERY_MISS);
    return null;
  }

  const payload = Buffer.from(
    JSON.stringify({
      shareKeys,
      title: tmdbInfo.title,
      year: tmdbInfo.year || null,
      altTitles: Array.isArray(tmdbInfo.altTitles) ? tmdbInfo.altTitles : [],
    })
  ).toString('base64');

  incrementCounter(METRIC.DISCOVERY_SUCCESS);
  return `MB::${payload}`;
}

module.exports = {
  search: async () => [],
  pickBestMatch: () => null,
  pickRankedMatches: () => [],
  computeMatchScore,
  getShowboxIdAndType: async () => null,
  getFebBoxShareKey: async () => null,
  isShareAlive: async () => true,
  resolveShareKeyForTitle,
  BOX_TYPE,
};
