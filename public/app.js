const form = document.getElementById('tts-form');
const textArea = document.getElementById('script-text');
const charCount = document.getElementById('char-count');
const toneSelect = document.getElementById('tone-select');
const accentSelect = document.getElementById('accent-select');
const generateBtn = document.getElementById('generate-btn');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error-banner');
const resultEl = document.getElementById('result');
const audioPlayer = document.getElementById('audio-player');
const downloadLink = document.getElementById('download-link');
const fallbackNoteEl = document.getElementById('fallback-note');

let currentAudioUrl = null;

textArea.addEventListener('input', () => {
  charCount.textContent = `${textArea.value.length} characters`;
});

async function loadOptions(selectEl, endpoint, itemsKey, defaultKeyProp, fallbackItems, fallbackDefault) {
  let items = fallbackItems;
  let defaultKey = fallbackDefault;

  try {
    const response = await fetch(endpoint);
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data[itemsKey]) && data[itemsKey].length > 0) {
        items = data[itemsKey];
        defaultKey = data[defaultKeyProp] || items[0].key;
      }
    }
  } catch {
    // Fall back to the built-in list if the request fails for any reason.
  }

  selectEl.innerHTML = '';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.key;
    option.textContent = item.label;
    selectEl.appendChild(option);
  }
  selectEl.value = defaultKey;
}

function loadTones() {
  return loadOptions(
    toneSelect,
    '/api/tones',
    'tones',
    'defaultTone',
    [
      { key: 'warm', label: 'Warm & Enthusiastic' },
      { key: 'joyful', label: 'Joyful & Upbeat' },
      { key: 'professional', label: 'Professional & Polished' },
      { key: 'casual', label: 'Casual & Friendly' },
      { key: 'confident', label: 'Confident & Bold' },
      { key: 'calm', label: 'Calm & Reassuring' },
    ],
    'warm'
  );
}

function loadAccents() {
  return loadOptions(
    accentSelect,
    '/api/accents',
    'accents',
    'defaultAccent',
    [
      { key: 'default', label: 'Default (Neutral)' },
      { key: 'indian', label: 'Indian English' },
      { key: 'american', label: 'American English' },
      { key: 'british', label: 'British English' },
      { key: 'australian', label: 'Australian English' },
    ],
    'default'
  );
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = textArea.value.trim();
  if (!text) return;

  errorEl.hidden = true;
  resultEl.hidden = true;
  loadingEl.hidden = false;
  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating…';

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        tone: toneSelect.value,
        accent: accentSelect.value,
      }),
    });

    if (!response.ok) {
      let message = 'Something went wrong while generating audio.';
      try {
        const data = await response.json();
        message = data.error || message;
      } catch {
        // Response wasn't JSON; keep the generic message.
      }
      throw new Error(message);
    }

    const usedFallback = response.headers.get('X-Used-Fallback') === 'true';
    const blob = await response.blob();

    if (currentAudioUrl) {
      URL.revokeObjectURL(currentAudioUrl);
    }
    currentAudioUrl = URL.createObjectURL(blob);

    audioPlayer.src = currentAudioUrl;
    downloadLink.href = currentAudioUrl;
    downloadLink.download = `voiceover-${Date.now()}.wav`;
    fallbackNoteEl.hidden = !usedFallback;
    resultEl.hidden = false;
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    loadingEl.hidden = true;
    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate Voiceover';
  }
});

loadTones();
loadAccents();
