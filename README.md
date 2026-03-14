# TikTok Live Contexto

A real-time word-guessing game for TikTok Live streams. Viewers type words in the chat, and the system scores each guess by semantic similarity to a secret word. A live leaderboard overlay shows the closest guesses.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Get a Cohere API key (optional but recommended)

1. Sign up at [cohere.com](https://cohere.com) (free tier works)
2. Go to Dashboard → API Keys
3. Copy your key

Without a Cohere key the game falls back to a letter-based heuristic scorer — playable but less accurate.

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and paste your Cohere API key.

### 4. Run the server

```bash
node bridge.js
```

The server starts on `http://localhost:8080` (configurable via `PORT` in `.env`).

## How to Play

### Host Instructions

1. Open `http://localhost:8080` in your browser
2. Enter your TikTok username and click **Connect**
3. Type the secret word in the password field and click **Set Word**
4. Go Live on TikTok and tell viewers: *"Type a word in the comments to guess the secret word!"*
5. Watch guesses appear on the leaderboard in real time
6. Use the **Hint** button to reveal a letter
7. Click **New Round** when done

### Viewer Instructions

- Type a single English word in the TikTok Live chat
- Your guess will be scored and ranked on the leaderboard
- Lower rank = closer to the secret word
- Rank #1 = you found it!

### Testing Without TikTok

Use the manual input at the bottom-right of the overlay. Format: `player:word` or just `word`.

## OBS Browser Source

1. In OBS, add a **Browser Source**
2. Set URL to `http://localhost:8080`
3. Set width/height to match your canvas (e.g. 1920×1080)
4. Check the **OBS** toggle in the overlay to enable transparent background

## Features

- Real-time TikTok Live chat integration
- Semantic word similarity scoring (Cohere embeddings or local fallback)
- Live leaderboard with proximity bars
- 3-second cooldown per player
- Hint system (reveals letters one at a time)
- Session score tracking across rounds
- Winner celebration with confetti
- Gift reaction notifications
- OBS overlay mode (transparent background)
- Max 500 guesses per round

## Troubleshooting

**"Failed to connect" error**
- Make sure you're currently Live on TikTok
- The username is case-sensitive — use your exact TikTok username
- Some regions may require a VPN

**Scores seem inaccurate**
- Without a Cohere API key, scoring uses a letter-based heuristic
- Add your Cohere key for semantic similarity scoring

**WebSocket disconnects**
- The overlay auto-reconnects every 2 seconds
- Check that `bridge.js` is still running

**OBS shows white background**
- Toggle the OBS checkbox in the overlay
- In OBS Browser Source properties, enable "Custom CSS" is empty/default
