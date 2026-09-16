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

- Paste a script into the text box, pick a **voice tone** (Warm, Joyful, Professional, Casual, Confident, or Calm), and click **Generate Voiceover**.
- The server wraps your text in a style instruction matching the chosen tone and sends it to a Gemini TTS model (`gemini-2.5-flash-preview-tts` by default).
- Scripts longer than ~4,000 characters are automatically split at paragraph/sentence boundaries into multiple chunks, sent to Gemini one at a time, and the resulting audio is stitched back together into a single WAV file.
- If the Gemini API returns a rate-limit/quota error (common on the free tier), the server retries a few times with exponential backoff. If `OPENAI_API_KEY` is set and Gemini is still rate-limited after those retries, the chunk is regenerated with OpenAI's TTS instead so the request still succeeds (the result shows a small note when this happens); without it, a clear quota error is returned. A stalled network call is also bounded by a request timeout so it fails with a clear error instead of hanging.
- The finished clip is streamed straight back in the HTTP response (no file is ever written to disk), so this works on hosts with a read-only filesystem too, such as serverless platforms.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | *(required)* | Your Gemini API key. Never hardcoded — the app will refuse to generate audio without it. |
| `PORT` | `3000` | Port the server listens on. |
| `TTS_MODEL` | `gemini-2.5-flash-preview-tts` | Gemini TTS model to use. |
| `TTS_VOICE_NAME` | `Puck` | Prebuilt Gemini voice name. |
| `OPENAI_API_KEY` | *(optional)* | Used only as a fallback when Gemini's rate limit/quota is hit. Without it, a quota hit just returns an error. |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | OpenAI TTS model used for the fallback. |
| `OPENAI_TTS_VOICE` | `alloy` | OpenAI voice used for the fallback. |

## Deploying to Render

This repo includes a `render.yaml` Blueprint, so Render can configure the service automatically:

1. In the Render dashboard, choose **New > Blueprint** and point it at this GitHub repo (or **New > Web Service** and set Build command `npm install` / Start command `npm start` manually).
2. Render will read `render.yaml` and create a Node web service on the free plan.
3. Set the `GEMINI_API_KEY` environment variable in the Render dashboard (it's intentionally left out of `render.yaml` so the key never lives in the repo).
4. Deploy — Render sets `PORT` automatically, which `server.js` already respects.

## Notes

- Max script length is 20,000 characters per request (configurable in `server.js` via `MAX_TOTAL_CHARS`).
- The app has no filesystem dependency, so the same `server.js` can also run on serverless hosts (e.g. Vercel) as a single full-stack deployment — just set `GEMINI_API_KEY` there too. Keep in mind such hosts often cap a single request's execution time (e.g. Vercel's default is much shorter than Render's), which can matter for long, multi-chunk scripts.
