import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TTS_MODEL = process.env.TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const TTS_VOICE_NAME = process.env.TTS_VOICE_NAME || 'Puck';

// Optional fallback used only when Gemini's own rate-limit retries are
// exhausted, so a quota hit degrades to a different voice instead of failing.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';

// Gemini TTS sessions support ~32k tokens of context and (aside from one
// preview streaming model) return the whole clip in a single response, so a
// script that fits comfortably under that gets sent as one request. Anything
// bigger is split into chunks and stitched back together after generation.
const CHUNK_CHAR_LIMIT = 4000;
const MAX_TOTAL_CHARS = 20000;

if (!GEMINI_API_KEY) {
  console.warn(
    '\n[warning] GEMINI_API_KEY is not set. Create a .env file (see .env.example) before generating audio.\n'
  );
}

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

const DEFAULT_TONE = 'warm';

const TONE_PRESETS = {
  warm: {
    label: 'Warm & Enthusiastic',
    instruction:
      'Say the following in a warm, conversational, and genuinely enthusiastic marketing ' +
      'voiceover style — like a real person excited to share great news with a friend. Use ' +
      'natural pacing, energy, and emphasis on the key words. Avoid sounding flat, stiff, or robotic.',
  },
  joyful: {
    label: 'Joyful & Upbeat',
    instruction:
      'Say the following in a joyful, upbeat, and energetic voiceover style — like someone who ' +
      "just got great news and can't wait to share it. Keep the tone bright and the pacing lively, " +
      'and let genuine excitement come through in every sentence.',
  },
  professional: {
    label: 'Professional & Polished',
    instruction:
      'Say the following in a professional, polished, and confident voiceover style — like a ' +
      'trusted expert presenting to executives. Speak with clear articulation and measured pacing, ' +
      'sounding credible and composed without being stiff or monotone.',
  },
  casual: {
    label: 'Casual & Friendly',
    instruction:
      'Say the following in a casual, relaxed, and friendly voiceover style — like chatting with a ' +
      'friend over coffee. Keep it natural and conversational, with light warmth rather than a ' +
      'polished or formal delivery.',
  },
  confident: {
    label: 'Confident & Bold',
    instruction:
      'Say the following in a confident, bold, and assertive voiceover style — like a motivational ' +
      'speaker who truly believes every word. Use strong emphasis and energetic pacing that commands ' +
      'attention without shouting.',
  },
  calm: {
    label: 'Calm & Reassuring',
    instruction:
      'Say the following in a calm, warm, and reassuring voiceover style — like a trusted advisor ' +
      'gently sharing good news. Use slow, steady pacing and a soothing tone with genuine care in ' +
      'every word.',
  },
};

const DEFAULT_ACCENT = 'default';

const ACCENT_PRESETS = {
  default: {
    label: 'Default (Neutral)',
    instruction: '',
  },
  indian: {
    label: 'Indian English',
    instruction: 'Speak with a natural Indian English accent.',
  },
  american: {
    label: 'American English',
    instruction: 'Speak with a natural American English accent.',
  },
  british: {
    label: 'British English',
    instruction: 'Speak with a natural British English accent.',
  },
  australian: {
    label: 'Australian English',
    instruction: 'Speak with a natural Australian English accent.',
  },
};

function buildStyleInstruction(toneKey, accentKey) {
  const tone = TONE_PRESETS[toneKey] || TONE_PRESETS[DEFAULT_TONE];
  const accent = ACCENT_PRESETS[accentKey] || ACCENT_PRESETS[DEFAULT_ACCENT];
  return accent.instruction ? `${tone.instruction} ${accent.instruction}` : tone.instruction;
}

function buildStyledPrompt(chunkText, toneKey, accentKey) {
  return `${buildStyleInstruction(toneKey, accentKey)}\n\n${chunkText}`;
}

class QuotaError extends Error {}

// Without an explicit timeout, a stalled connection to Gemini's API (e.g. a
// flaky network path from the host) hangs the request forever with no error
// ever surfacing to the client. This bounds every attempt so a stuck call
// fails loudly instead of leaving the user stuck on "Generating...".
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RATE_LIMIT_RETRIES = 4;
const MAX_TRANSIENT_RETRIES = 2;

// OpenAI's audio/speech endpoint can return raw PCM (response_format: 'pcm')
// at the same 24kHz/mono/16-bit layout Gemini uses, so a fallback chunk can
// be concatenated with Gemini chunks and wrapped in one WAV header exactly
// like a normal chunk — no format conversion needed.
async function generateSpeechViaOpenAI(chunkText, toneKey, accentKey) {
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
      input: chunkText,
      instructions: buildStyleInstruction(toneKey, accentKey),
      response_format: 'pcm',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenAI TTS request failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    sampleRate: 24000,
    provider: 'openai',
  };
}

async function generateSpeechForChunk(chunkText, toneKey, accentKey) {
  const prompt = buildStyledPrompt(chunkText, toneKey, accentKey);
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
        provider: 'gemini',
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
        if (OPENAI_API_KEY) {
          try {
            return await generateSpeechViaOpenAI(chunkText, toneKey, accentKey);
          } catch (fallbackErr) {
            throw new QuotaError(
              "Gemini's rate limit was hit and the OpenAI fallback also failed: " +
                fallbackErr.message
            );
          }
        }
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

app.get('/api/tones', (req, res) => {
  res.json({
    tones: Object.entries(TONE_PRESETS).map(([key, preset]) => ({
      key,
      label: preset.label,
    })),
    defaultTone: DEFAULT_TONE,
  });
});

app.get('/api/accents', (req, res) => {
  res.json({
    accents: Object.entries(ACCENT_PRESETS).map(([key, preset]) => ({
      key,
      label: preset.label,
    })),
    defaultAccent: DEFAULT_ACCENT,
  });
});

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

    const requestedTone = typeof req.body?.tone === 'string' ? req.body.tone : '';
    const tone = Object.prototype.hasOwnProperty.call(TONE_PRESETS, requestedTone)
      ? requestedTone
      : DEFAULT_TONE;

    const requestedAccent = typeof req.body?.accent === 'string' ? req.body.accent : '';
    const accent = Object.prototype.hasOwnProperty.call(ACCENT_PRESETS, requestedAccent)
      ? requestedAccent
      : DEFAULT_ACCENT;

    const chunks = splitTextIntoChunks(text, CHUNK_CHAR_LIMIT);
    const audioChunks = [];
    let sampleRate = 24000;
    let usedFallback = false;

    for (let i = 0; i < chunks.length; i += 1) {
      const { buffer, sampleRate: chunkRate, provider } = await generateSpeechForChunk(
        chunks[i],
        tone,
        accent
      );
      audioChunks.push(buffer);
      if (i === 0) sampleRate = chunkRate;
      if (provider === 'openai') usedFallback = true;

      if (i < chunks.length - 1) await sleep(300);
    }

    const combinedPcm = Buffer.concat(audioChunks);
    const wavBuffer = pcmToWav(combinedPcm, sampleRate, 1, 16);

    // Serve the finished clip straight from the response instead of writing it
    // to disk first — some hosts (e.g. serverless platforms) run this handler
    // in a read-only filesystem, and even on hosts that allow writes, a later
    // request for a saved file isn't guaranteed to land on the same instance.
    res.set({
      'Content-Type': 'audio/wav',
      'Content-Disposition': `attachment; filename="voiceover-${Date.now()}.wav"`,
      'X-Chunk-Count': String(chunks.length),
      'X-Used-Fallback': String(usedFallback),
    });
    res.send(wavBuffer);
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
