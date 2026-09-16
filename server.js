import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TTS_MODEL = process.env.TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const TTS_VOICE_NAME = process.env.TTS_VOICE_NAME || 'Puck';

// Gemini TTS sessions support ~32k tokens of context and (aside from one
// preview streaming model) return the whole clip in a single response, so a
// script that fits comfortably under that gets sent as one request. Anything
// bigger is split into chunks and stitched back together after generation.
const CHUNK_CHAR_LIMIT = 4000;
const MAX_TOTAL_CHARS = 20000;

const OUTPUT_DIR = path.join(__dirname, 'outputs');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

if (!GEMINI_API_KEY) {
  console.warn(
    '\n[warning] GEMINI_API_KEY is not set. Create a .env file (see .env.example) before generating audio.\n'
  );
}

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/outputs', express.static(OUTPUT_DIR));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Splits text into chunks no larger than maxChars, preferring to break on
 * paragraph boundaries, then sentence boundaries, and only hard-splitting
 * mid-sentence as a last resort for a single run-on sentence.
 */
function splitTextIntoChunks(text, maxChars) {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let current = '';

  const flush = () => {
    if (current.trim().length > 0) chunks.push(current.trim());
    current = '';
  };

  const addSentenceChunks = (paragraph) => {
    const sentences = paragraph.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [paragraph];
    for (const rawSentence of sentences) {
      const sentence = rawSentence.trim();
      if (!sentence) continue;

      if ((current ? current + ' ' + sentence : sentence).length <= maxChars) {
        current = current ? current + ' ' + sentence : sentence;
        continue;
      }

      flush();

      if (sentence.length <= maxChars) {
        current = sentence;
      } else {
        for (let i = 0; i < sentence.length; i += maxChars) {
          chunks.push(sentence.slice(i, i + maxChars));
        }
      }
    }
  };

  for (const rawParagraph of paragraphs) {
    const paragraph = rawParagraph.trim();
    if (!paragraph) continue;

    const combined = current ? current + '\n\n' + paragraph : paragraph;
    if (combined.length <= maxChars) {
      current = combined;
      continue;
    }

    flush();

    if (paragraph.length <= maxChars) {
      current = paragraph;
    } else {
      addSentenceChunks(paragraph);
    }
  }

  flush();
  return chunks;
}

function extractSampleRate(mimeType, fallback = 24000) {
  const match = /rate=(\d+)/.exec(mimeType || '');
  return match ? parseInt(match[1], 10) : fallback;
}

function pcmToWav(pcmData, sampleRate, numChannels = 1, bitDepth = 16) {
  const byteRate = (sampleRate * numChannels * bitDepth) / 8;
  const blockAlign = (numChannels * bitDepth) / 8;
  const dataSize = pcmData.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}

function buildStyledPrompt(chunkText) {
  return (
    'Say the following in a warm, conversational, and genuinely enthusiastic ' +
    'marketing voiceover style — like a real person excited to share great news ' +
    'with a friend. Use natural pacing, energy, and emphasis on the key words. ' +
    'Avoid sounding flat, stiff, or robotic.\n\n' +
    chunkText
  );
}

class QuotaError extends Error {}

// Without an explicit timeout, a stalled connection to Gemini's API (e.g. a
// flaky network path from the host) hangs the request forever with no error
// ever surfacing to the client. This bounds every attempt so a stuck call
// fails loudly instead of leaving the user stuck on "Generating...".
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RATE_LIMIT_RETRIES = 4;
const MAX_TRANSIENT_RETRIES = 2;

async function generateSpeechForChunk(chunkText) {
  const prompt = buildStyledPrompt(chunkText);
  let rateLimitAttempts = 0;
  let transientAttempts = 0;
  let delay = 1000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const response = await ai.models.generateContent({
        model: TTS_MODEL,
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE_NAME } },
          },
          httpOptions: { timeout: REQUEST_TIMEOUT_MS },
        },
      });

      const part = response?.candidates?.[0]?.content?.parts?.[0];
      const audioData = part?.inlineData?.data;
      if (!audioData) {
        throw new Error('Gemini did not return any audio for this chunk.');
      }

      return {
        buffer: Buffer.from(audioData, 'base64'),
        sampleRate: extractSampleRate(part.inlineData.mimeType),
      };
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      const message = String(err?.message || '');
      const isRateLimit =
        status === 429 || /RESOURCE_EXHAUSTED|rate limit|quota/i.test(message);
      const isTransient =
        !isRateLimit &&
        /timeout|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|aborted|fetch failed/i.test(
          message
        );

      if (isRateLimit && rateLimitAttempts < MAX_RATE_LIMIT_RETRIES) {
        rateLimitAttempts += 1;
        await sleep(delay);
        delay *= 2;
        continue;
      }

      if (isTransient && transientAttempts < MAX_TRANSIENT_RETRIES) {
        transientAttempts += 1;
        await sleep(2000);
        continue;
      }

      if (isRateLimit) {
        throw new QuotaError(
          "You've hit the Gemini API's rate limit or free-tier quota. Please wait a minute and try again."
        );
      }

      if (isTransient) {
        throw new Error(
          'The request to the Gemini API timed out. Please try again in a moment.'
        );
      }

      throw err;
    }
  }
}

app.post('/api/generate', async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({
        error: 'Server is missing GEMINI_API_KEY. Set it in a .env file and restart the server.',
      });
    }

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      return res.status(400).json({ error: 'Please enter some script text.' });
    }
    if (text.length > MAX_TOTAL_CHARS) {
      return res.status(400).json({
        error: `Script is too long (${text.length} characters). Please keep it under ${MAX_TOTAL_CHARS} characters.`,
      });
    }

    const chunks = splitTextIntoChunks(text, CHUNK_CHAR_LIMIT);
    const audioChunks = [];
    let sampleRate = 24000;

    for (let i = 0; i < chunks.length; i += 1) {
      const { buffer, sampleRate: chunkRate } = await generateSpeechForChunk(chunks[i]);
      audioChunks.push(buffer);
      if (i === 0) sampleRate = chunkRate;

      if (i < chunks.length - 1) await sleep(300);
    }

    const combinedPcm = Buffer.concat(audioChunks);
    const wavBuffer = pcmToWav(combinedPcm, sampleRate, 1, 16);

    const filename = `voiceover-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.wav`;
    await fs.promises.writeFile(path.join(OUTPUT_DIR, filename), wavBuffer);

    res.json({ audioUrl: `/outputs/${filename}`, chunkCount: chunks.length });
  } catch (err) {
    console.error(err);
    if (err instanceof QuotaError) {
      return res.status(429).json({ error: err.message });
    }
    res.status(500).json({ error: err.message || 'Failed to generate speech.' });
  }
});

app.listen(PORT, () => {
  console.log(`Marketing TTS tool running at http://localhost:${PORT}`);
});
