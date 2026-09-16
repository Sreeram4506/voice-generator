const form = document.getElementById('tts-form');
const textArea = document.getElementById('script-text');
const charCount = document.getElementById('char-count');
const generateBtn = document.getElementById('generate-btn');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error-banner');
const resultEl = document.getElementById('result');
const audioPlayer = document.getElementById('audio-player');
const downloadLink = document.getElementById('download-link');

textArea.addEventListener('input', () => {
  charCount.textContent = `${textArea.value.length} characters`;
});

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
      body: JSON.stringify({ text }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Something went wrong while generating audio.');
    }

    audioPlayer.src = data.audioUrl;
    downloadLink.href = data.audioUrl;
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
