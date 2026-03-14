require('dotenv').config();

const LOG = {
  info: (msg) => console.log(`\x1b[36m[SIM]\x1b[0m ${msg}`),
  warn: (msg) => console.log(`\x1b[33m[SIM]\x1b[0m ${msg}`),
  error: (msg) => console.log(`\x1b[31m[SIM]\x1b[0m ${msg}`),
};

/** @type {Map<string, number[]>} */
const embeddingCache = new Map();

/** @type {import('cohere-ai').CohereClientV2 | null} */
let cohereClient = null;

/**
 * Initialise Cohere client lazily.
 * @returns {import('cohere-ai').CohereClientV2 | null}
 */
function getCohere() {
  if (cohereClient) return cohereClient;
  const key = process.env.COHERE_API_KEY;
  if (!key || key === 'your_key_here') {
    LOG.warn('No valid COHERE_API_KEY — falling back to local heuristic scoring');
    return null;
  }
  try {
    const { CohereClientV2 } = require('cohere-ai');
    cohereClient = new CohereClientV2({ token: key });
    LOG.info('Cohere client initialised');
    return cohereClient;
  } catch (err) {
    LOG.error(`Failed to init Cohere: ${err.message}`);
    return null;
  }
}

/**
 * Fetch embeddings for a list of words via Cohere.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function fetchEmbeddings(texts) {
  const co = getCohere();
  if (!co) return [];
  try {
    const res = await co.embed({
      texts,
      model: 'embed-english-v3.0',
      inputType: 'search_query',
      embeddingTypes: ['float'],
    });
    return res.embeddings.float;
  } catch (err) {
    LOG.error(`Cohere embed error: ${err.message}`);
    return [];
  }
}

/**
 * Cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Local letter-based heuristic fallback.
 * Combines bigram overlap with length similarity — rough but playable.
 * @param {string} a
 * @param {string} b
 * @returns {number} similarity between 0 and 1
 */
function letterHeuristic(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) return 1;

  // Bigram overlap
  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const setA = bigrams(a);
  const setB = bigrams(b);
  let intersection = 0;
  for (const bg of setA) if (setB.has(bg)) intersection++;
  const union = setA.size + setB.size - intersection;
  const bigramSim = union === 0 ? 0 : intersection / union;

  // Shared letters ratio
  const freqA = {}, freqB = {};
  for (const c of a) freqA[c] = (freqA[c] || 0) + 1;
  for (const c of b) freqB[c] = (freqB[c] || 0) + 1;
  let shared = 0;
  for (const c of Object.keys(freqA)) shared += Math.min(freqA[c] || 0, freqB[c] || 0);
  const letterSim = (2 * shared) / (a.length + b.length);

  // Length similarity
  const lenSim = 1 - Math.abs(a.length - b.length) / Math.max(a.length, b.length);

  return bigramSim * 0.4 + letterSim * 0.4 + lenSim * 0.2;
}

// Simple English word regex: letters only, 2-20 chars
const WORD_RE = /^[a-zA-Z]{2,20}$/;

/**
 * Score a guessed word against the secret word.
 * Returns a rank: 1 = exact match, higher = less similar.
 * Returns null if the guess is not a valid word.
 *
 * @param {string} guess - The viewer's guessed word
 * @param {string} secretWord - The host's secret word
 * @returns {Promise<{rank: number, similarity: number} | null>}
 */
async function scoreWord(guess, secretWord) {
  guess = guess.trim().toLowerCase();
  secretWord = secretWord.trim().toLowerCase();

  if (!WORD_RE.test(guess)) return null;
  if (guess === secretWord) return { rank: 1, similarity: 1 };

  const co = getCohere();

  if (co) {
    // Embedding-based scoring
    const cacheKey = (w) => `emb:${w}`;
    const toFetch = [];
    if (!embeddingCache.has(cacheKey(guess))) toFetch.push(guess);
    if (!embeddingCache.has(cacheKey(secretWord))) toFetch.push(secretWord);

    if (toFetch.length > 0) {
      const embeddings = await fetchEmbeddings(toFetch);
      if (embeddings.length === toFetch.length) {
        toFetch.forEach((w, i) => embeddingCache.set(cacheKey(w), embeddings[i]));
      }
    }

    const embGuess = embeddingCache.get(cacheKey(guess));
    const embSecret = embeddingCache.get(cacheKey(secretWord));

    if (embGuess && embSecret) {
      const sim = cosineSimilarity(embGuess, embSecret);
      // Convert similarity (0-1) to rank (1-1000)
      const rank = Math.max(2, Math.round((1 - sim) * 1000));
      return { rank, similarity: sim };
    }
  }

  // Fallback to letter heuristic
  const sim = letterHeuristic(guess, secretWord);
  const rank = Math.max(2, Math.round((1 - sim) * 1000));
  return { rank, similarity: sim };
}

/**
 * Validate if a string looks like a single English word.
 * @param {string} word
 * @returns {boolean}
 */
function isValidWord(word) {
  return WORD_RE.test(word.trim());
}

/**
 * Clear the embedding cache (for new rounds).
 */
function clearCache() {
  embeddingCache.clear();
  LOG.info('Embedding cache cleared');
}

module.exports = { scoreWord, isValidWord, clearCache };
