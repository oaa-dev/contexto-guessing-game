const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { WebcastPushConnection } = require('tiktok-live-connector');
const { scoreWord, isValidWord, clearCache } = require('./similarity');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const AUTO_ROUND_DELAY = 10000; // 10s celebration before auto new round

// ── Datamuse word pool ─────────────────────────────────────────────────────

/** @type {string[]} */
let wordPool = [];
let lastWord = '';
const DATAMUSE_TOPICS = [
  'ml=animal', 'ml=food', 'ml=sport', 'ml=music', 'ml=weather',
  'ml=color', 'ml=tool', 'ml=nature', 'ml=ocean', 'ml=space',
  'ml=city', 'ml=clothing', 'ml=furniture', 'ml=vehicle', 'ml=fruit',
  'ml=flower', 'ml=emotion', 'ml=science', 'ml=building', 'ml=metal',
];

/**
 * Fetch words from Datamuse API and fill the pool.
 * Uses multiple topic queries for variety.
 */
async function fillWordPool() {
  LOG.info('Fetching words from Datamuse API...');
  const results = new Set();

  // Fetch multiple topics in parallel
  const topics = DATAMUSE_TOPICS.sort(() => Math.random() - 0.5).slice(0, 6);
  const fetches = topics.map(async (topic) => {
    try {
      const url = `https://api.datamuse.com/words?${topic}&max=100&md=f`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      for (const item of data) {
        const w = item.word.toLowerCase();
        // Only single words, 3-10 letters, no spaces/hyphens
        if (/^[a-z]{3,10}$/.test(w)) {
          // Filter by frequency — only common-ish words (tags include f:XX.XX)
          const freqTag = item.tags?.find(t => t.startsWith('f:'));
          const freq = freqTag ? parseFloat(freqTag.slice(2)) : 0;
          if (freq >= 1) results.add(w);
        }
      }
    } catch (err) {
      LOG.warn(`Datamuse fetch failed for "${topic}": ${err.message}`);
    }
  });

  await Promise.all(fetches);

  if (results.size > 0) {
    wordPool = [...results];
    LOG.info(`Word pool loaded: ${wordPool.length} words from Datamuse`);
  } else {
    // Fallback if API is unreachable
    wordPool = [
      'apple','ocean','castle','dragon','forest','guitar','island','kitchen',
      'lemon','mirror','orange','piano','river','silver','thunder','umbrella',
      'village','window','anchor','candle','desert','engine','falcon','garden',
      'harbor','jacket','knight','marble','palace','rocket','shadow','temple',
      'valley','crystal','dolphin','eagle','flame','glacier','horizon','jewel',
      'library','mountain','penguin','rainbow','tornado','volcano','warrior',
      'blanket','diamond','eclipse','feather','ghost','helmet','kingdom','leopard',
      'magnet','oracle','phantom','rabbit','shield','tiger','whisper','basket',
      'cherry','flower','museum','pillow','salmon','wizard','butter','circus',
      'mango','travel','bamboo','empire','frozen','genius','hunter','python',
      'stable','target','cactus','rescue','signal','vortex','zenith',
    ];
    LOG.warn('Using fallback word list — Datamuse unavailable');
  }
}

/**
 * Pick a random word from the pool, avoiding the last one.
 * Refills pool from Datamuse if running low.
 * @returns {Promise<string>}
 */
async function pickWord() {
  if (wordPool.length < 10) {
    await fillWordPool();
  }

  let word;
  let attempts = 0;
  do {
    const idx = Math.floor(Math.random() * wordPool.length);
    word = wordPool[idx];
    // Remove used word from pool so we don't repeat
    wordPool.splice(idx, 1);
    attempts++;
  } while (word === lastWord && wordPool.length > 0 && attempts < 5);

  lastWord = word;
  return word;
}

const LOG = {
  info: (msg) => console.log(`\x1b[32m[BRIDGE ${ts()}]\x1b[0m ${msg}`),
  warn: (msg) => console.log(`\x1b[33m[BRIDGE ${ts()}]\x1b[0m ${msg}`),
  error: (msg) => console.log(`\x1b[31m[BRIDGE ${ts()}]\x1b[0m ${msg}`),
  chat: (msg) => console.log(`\x1b[35m[CHAT ${ts()}]\x1b[0m ${msg}`),
};

function ts() {
  return new Date().toISOString().slice(11, 19);
}

// ── HTTP server (serves overlay.html) ──────────────────────────────────────

const MANIFEST = JSON.stringify({
  name: 'TikTok Contexto',
  short_name: 'Contexto',
  description: 'TikTok Live word-guessing game',
  start_url: '/',
  display: 'standalone',
  background_color: '#0a0a0f',
  theme_color: '#fe2c55',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
});

const SW_JS = `
const CACHE = 'contexto-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/ws') || e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
`;

/**
 * Generate a valid PNG icon using raw bytes (no dependencies).
 * Creates a solid #fe2c55 pink square at the requested size.
 */
function generateIcon(size) {
  const zlib = require('zlib');

  // Build raw RGBA pixel data: solid pink
  const r = 0xfe, g = 0x2c, b = 0x55, a = 0xff;
  const rowBytes = 1 + size * 4; // filter byte + RGBA per pixel
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    const off = y * rowBytes;
    raw[off] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 4;
      raw[p] = r; raw[p+1] = g; raw[p+2] = b; raw[p+3] = a;
    }
  }

  const compressed = zlib.deflateSync(raw);

  // PNG file structure
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type);
    const crcData = Buffer.concat([typeB, data]);
    const crc = Buffer.alloc(4);
    crc.writeInt32BE(crc32(crcData));
    return Buffer.concat([len, typeB, data, crc]);
  }

  // CRC32
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) | 0;
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Pre-generate icons at startup so they're fast to serve
const icon192 = generateIcon(192);
const icon512 = generateIcon(512);

const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/overlay.html') {
    const filePath = path.join(__dirname, 'overlay.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading overlay');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else if (req.url === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(MANIFEST);
  } else if (req.url === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(SW_JS);
  } else if (req.url === '/icon-192.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(icon192);
  } else if (req.url === '/icon-512.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(icon512);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ── WebSocket server ───────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

/** @type {WebcastPushConnection | null} */
let tiktokConnection = null;
let connectedUsername = null;

/** Broadcast a JSON message to all connected WS clients */
function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

/**
 * Connect to a TikTok Live stream.
 * @param {string} username
 */
async function connectTikTok(username) {
  if (tiktokConnection) {
    try { await tiktokConnection.disconnect(); } catch (_) {}
    tiktokConnection = null;
  }

  LOG.info(`Connecting to TikTok Live: @${username}`);
  tiktokConnection = new WebcastPushConnection(username);

  try {
    const state = await tiktokConnection.connect();
    connectedUsername = username;
    LOG.info(`Connected to @${username} — Room ID: ${state.roomId}, Viewers: ${state.viewerCount ?? '?'}`);
    broadcast({ type: 'status', status: 'connected', username });

    tiktokConnection.on('chat', (data) => {
      const msg = {
        type: 'comment',
        username: data.uniqueId || data.nickname || 'anonymous',
        nickname: data.nickname || data.uniqueId || 'anonymous',
        profilePic: data.profilePictureUrl || '',
        comment: data.comment,
        timestamp: Date.now(),
      };
      LOG.chat(`${msg.username}: ${msg.comment}`);
      broadcast(msg);
    });

    tiktokConnection.on('gift', (data) => {
      const msg = {
        type: 'gift',
        username: data.uniqueId || data.nickname || 'anonymous',
        nickname: data.nickname || data.uniqueId || 'anonymous',
        profilePic: data.profilePictureUrl || '',
        giftName: data.giftName,
        diamondCount: data.diamondCount,
        timestamp: Date.now(),
      };
      LOG.info(`Gift from ${msg.username}: ${msg.giftName} (${msg.diamondCount} diamonds)`);
      broadcast(msg);
    });

    tiktokConnection.on('roomUser', (data) => {
      broadcast({ type: 'viewerCount', count: data.viewerCount });
    });

    tiktokConnection.on('streamEnd', () => {
      LOG.warn('Stream ended');
      broadcast({ type: 'status', status: 'disconnected', reason: 'stream_ended' });
      tiktokConnection = null;
      connectedUsername = null;
    });

    tiktokConnection.on('error', (err) => {
      LOG.error(`TikTok error: ${err.message}`);
    });

    tiktokConnection.on('disconnected', () => {
      LOG.warn('Disconnected from TikTok');
      broadcast({ type: 'status', status: 'disconnected' });
      tiktokConnection = null;
      connectedUsername = null;
    });
  } catch (err) {
    LOG.error(`Failed to connect: ${err.message}`);
    broadcast({ type: 'status', status: 'error', message: err.message });
    tiktokConnection = null;
  }
}

/** Disconnect from TikTok Live */
async function disconnectTikTok() {
  if (tiktokConnection) {
    try { await tiktokConnection.disconnect(); } catch (_) {}
    tiktokConnection = null;
    connectedUsername = null;
    LOG.info('Disconnected from TikTok');
    broadcast({ type: 'status', status: 'disconnected' });
  }
}

// ── Game state ─────────────────────────────────────────────────────────────

let secretWord = '';
/** @type {Map<string, {word: string, rank: number, similarity: number, player: string, time: number}>} */
let guesses = new Map();
let totalGuesses = 0;
/** @type {Set<string>} */
let players = new Set();
/** @type {Map<string, number>} */
let cooldowns = new Map();
/** @type {Map<string, number>} */
let sessionScores = new Map();
let revealedLetters = new Set();
let autoRoundTimer = null;
let roundActive = false;

const COOLDOWN_MS = 3000;
const MAX_GUESSES = 500;

/** @type {Map<string, {nickname: string, profilePic: string}>} */
const playerProfiles = new Map();

/**
 * Process a word guess from a viewer.
 * @param {string} word
 * @param {string} player
 */
async function processGuess(word, player) {
  word = word.trim().toLowerCase();

  if (!secretWord || !roundActive) return;
  if (!isValidWord(word)) return;
  if (guesses.has(word)) {
    broadcast({ type: 'duplicate', word, player });
    return;
  }

  // Cooldown check
  const now = Date.now();
  const lastGuess = cooldowns.get(player) || 0;
  if (now - lastGuess < COOLDOWN_MS) return;
  cooldowns.set(player, now);

  if (totalGuesses >= MAX_GUESSES) {
    broadcast({ type: 'maxGuesses' });
    // Auto new round after max guesses
    clearTimeout(autoRoundTimer);
    autoRoundTimer = setTimeout(() => newRound(), 5000);
    return;
  }

  try {
    const result = await scoreWord(word, secretWord);
    if (!result) return;

    totalGuesses++;
    players.add(player);

    const profile = playerProfiles.get(player) || { nickname: player, profilePic: '' };
    const entry = {
      word,
      rank: result.rank,
      similarity: result.similarity,
      player,
      nickname: profile.nickname,
      profilePic: profile.profilePic,
      time: now,
    };
    guesses.set(word, entry);

    // Session score tracking — lower total rank = better
    sessionScores.set(player, (sessionScores.get(player) || 0) + Math.max(0, 1000 - result.rank));

    const sorted = [...guesses.values()].sort((a, b) => a.rank - b.rank);
    const leaderboard = sorted.slice(0, 50);

    broadcast({
      type: 'guess',
      entry,
      stats: {
        totalGuesses,
        uniqueWords: guesses.size,
        players: players.size,
      },
      leaderboard,
    });

    if (result.rank === 1) {
      roundActive = false;
      LOG.info(`WINNER! ${player} guessed "${word}"`);
      broadcast({
        type: 'winner',
        word,
        player,
        totalGuesses,
        sessionScores: Object.fromEntries(sessionScores),
        nextRoundIn: AUTO_ROUND_DELAY,
      });

      // Auto-start new round after delay
      clearTimeout(autoRoundTimer);
      autoRoundTimer = setTimeout(() => {
        newRound();
      }, AUTO_ROUND_DELAY);
    }
  } catch (err) {
    LOG.error(`Score error: ${err.message}`);
  }
}

/** Reset the game for a new round — auto-picks a secret word from Datamuse */
async function newRound() {
  clearTimeout(autoRoundTimer);
  secretWord = await pickWord();
  guesses = new Map();
  totalGuesses = 0;
  players = new Set();
  cooldowns = new Map();
  revealedLetters = new Set();
  roundActive = true;
  clearCache();
  LOG.info(`New round started — secret word: "${secretWord}"`);
  broadcast({
    type: 'newRound',
    stats: { totalGuesses: 0, uniqueWords: 0, players: 0 },
    leaderboard: [],
    wordLength: secretWord.length,
  });
}

// ── WebSocket message handling ─────────────────────────────────────────────

wss.on('connection', (ws) => {
  LOG.info('Overlay client connected');

  ws.send(JSON.stringify({
    type: 'init',
    connected: !!tiktokConnection,
    username: connectedUsername,
    roundActive,
    wordLength: secretWord ? secretWord.length : 0,
    stats: {
      totalGuesses,
      uniqueWords: guesses.size,
      players: players.size,
    },
    leaderboard: [...guesses.values()].sort((a, b) => a.rank - b.rank).slice(0, 50),
  }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      LOG.warn('Invalid JSON from client');
      return;
    }

    if (!msg || !msg.action) {
      LOG.warn('Missing action in message');
      return;
    }

    switch (msg.action) {
      case 'connect':
        if (typeof msg.username === 'string' && msg.username.trim()) {
          await connectTikTok(msg.username.trim());
        }
        break;

      case 'disconnect':
        await disconnectTikTok();
        break;

      case 'newRound':
        await newRound();
        break;

      case 'guess':
        if (typeof msg.word === 'string' && typeof msg.player === 'string') {
          // Store profile info if provided
          if (msg.nickname || msg.profilePic) {
            playerProfiles.set(msg.player, {
              nickname: msg.nickname || msg.player,
              profilePic: msg.profilePic || '',
            });
          }
          await processGuess(msg.word, msg.player);
        }
        break;

      case 'hint':
        if (secretWord) {
          const unrevealed = [];
          for (let i = 0; i < secretWord.length; i++) {
            if (!revealedLetters.has(i)) unrevealed.push(i);
          }
          if (unrevealed.length > 0) {
            const idx = unrevealed[Math.floor(Math.random() * unrevealed.length)];
            revealedLetters.add(idx);
            const hint = secretWord.split('').map((c, i) => revealedLetters.has(i) ? c : '_').join(' ');
            broadcast({ type: 'hint', hint, revealed: revealedLetters.size, total: secretWord.length });
            LOG.info(`Hint revealed: ${hint}`);
          }
        }
        break;

      default:
        LOG.warn(`Unknown action: ${msg.action}`);
    }
  });

  ws.on('close', () => LOG.info('Overlay client disconnected'));
});

// ── Start server ───────────────────────────────────────────────────────────

async function start() {
  // Pre-fill word pool from Datamuse
  await fillWordPool();

  httpServer.listen(PORT, async () => {
    LOG.info(`Server running on http://localhost:${PORT}`);
    LOG.info(`WebSocket on ws://localhost:${PORT}`);
    LOG.info('Open http://localhost:' + PORT + ' in your browser for the overlay');

    // Auto-start first round
    await newRound();
  });
}

start().catch((err) => {
  LOG.error(`Startup failed: ${err.message}`);
  process.exit(1);
});
