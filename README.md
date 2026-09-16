# Marketing Voiceover Generator

A minimal web tool for turning marketing scripts into natural-sounding voiceovers using the Gemini API's text-to-speech models.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and add your Gemini API key (get one at https://aistudio.google.com/apikey):

   ```bash
   cp .env.example .env
   ```

3. Start the server:

   ```bash
   npm start
   ```

4. Open http://localhost:3000

## How it works

- Paste a script into the text box and click **Generate Voiceover**.
- The server wraps your text in a style instruction ("warm, conversational, enthusiastic marketing voiceover") and sends it to a Gemini TTS model (`gemini-2.5-flash-preview-tts` by default).
- Scripts longer than ~4,000 characters are automatically split at paragraph/sentence boundaries into multiple chunks, sent to Gemini one at a time, and the resulting audio is stitched back together into a single WAV file.
- If the Gemini API returns a rate-limit/quota error (common on the free tier), the server retries a few times with exponential backoff before surfacing a clear error message.
- The finished file is saved under `outputs/` and served back to the browser for preview and download.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | *(required)* | Your Gemini API key. Never hardcoded — the app will refuse to generate audio without it. |
| `PORT` | `3000` | Port the server listens on. |
| `TTS_MODEL` | `gemini-2.5-flash-preview-tts` | Gemini TTS model to use. |
| `TTS_VOICE_NAME` | `Puck` | Prebuilt Gemini voice name. |

## Deploying to Render

This repo includes a `render.yaml` Blueprint, so Render can configure the service automatically:

1. In the Render dashboard, choose **New > Blueprint** and point it at this GitHub repo (or **New > Web Service** and set Build command `npm install` / Start command `npm start` manually).
2. Render will read `render.yaml` and create a Node web service on the free plan.
3. Set the `GEMINI_API_KEY` environment variable in the Render dashboard (it's intentionally left out of `render.yaml` so the key never lives in the repo).
4. Deploy — Render sets `PORT` automatically, which `server.js` already respects.

Note: Render's filesystem is ephemeral, so files written to `outputs/` don't survive a redeploy/restart. That's fine here since each `.wav` only needs to live long enough for the browser to fetch it right after generation.

## Notes

- Generated `.wav` files accumulate in `outputs/`; feel free to delete old ones periodically.
- Max script length is 20,000 characters per request (configurable in `server.js` via `MAX_TOTAL_CHARS`).
