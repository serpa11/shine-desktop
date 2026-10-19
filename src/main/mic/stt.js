'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/**
 * Speech-to-text engines for Shine's push-to-talk dictation.
 *
 *   api    - Whisper-compatible HTTP endpoint (OpenAI, Groq, or any custom
 *            OpenAI-compatible host). Uses the key already stored in Shine's
 *            settings so nothing has to be configured twice.
 *   vosk   - fully offline recognition with a local Vosk model. Nothing leaves
 *            the PC.
 *   off    - transcription disabled.
 */

/* ------------------------------------------------------------------ */
/* WAV helpers                                                        */
/* ------------------------------------------------------------------ */

/** Wrap 16 kHz mono float samples in a canonical 44-byte RIFF/WAVE header. */
function pcmToWav(samples, sampleRate = 16000) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2);
  }
  return buffer;
}

/* ------------------------------------------------------------------ */
/* API engine                                                         */
/* ------------------------------------------------------------------ */

function resolveApiTarget(credentials) {
  const { sttBaseUrl, sttApiKey, sttProvider } = credentials || {};
  const provider = sttProvider || (sttApiKey && sttApiKey.startsWith('gsk_') ? 'groq' : 'openai');

  if (sttBaseUrl) {
    return {
      url: `${String(sttBaseUrl).replace(/\/+$/, '')}/audio/transcriptions`,
      headers: { Authorization: `Bearer ${sttApiKey || ''}` },
      provider: 'custom',
    };
  }
  if (provider === 'groq') {
    return {
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      headers: { Authorization: `Bearer ${sttApiKey}` },
      provider: 'groq',
    };
  }
  return {
    url: 'https://api.openai.com/v1/audio/transcriptions',
    headers: { Authorization: `Bearer ${sttApiKey}` },
    provider: 'openai',
  };
}

async function transcribeWithApi({ wav, credentials, model, language, signal }) {
  const target = resolveApiTarget(credentials);
  if (!target.headers.Authorization || target.headers.Authorization === 'Bearer ') {
    throw new Error('Dictation needs an API key. Open Shine Settings and add an OpenAI, Groq or Custom API key, or switch dictation to the offline engine.');
  }

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'shine-dictation.wav');
  form.append('model', model || 'whisper-1');
  form.append('response_format', 'json');
  if (language && language !== 'auto') form.append('language', language);

  const res = await fetch(target.url, { method: 'POST', headers: target.headers, body: form, signal });
  const raw = await res.text();
  if (!res.ok) {
    let detail = raw;
    try {
      detail = JSON.parse(raw)?.error?.message || raw;
    } catch {}
    throw new Error(`Speech-to-text failed (HTTP ${res.status}): ${String(detail).slice(0, 400)}`);
  }
  try {
    const data = JSON.parse(raw);
    return { text: (data.text || '').trim(), engine: 'api', provider: target.provider };
  } catch {
    return { text: raw.trim(), engine: 'api', provider: target.provider };
  }
}

/* ------------------------------------------------------------------ */
/* Vosk engine                                                        */
/* ------------------------------------------------------------------ */

let voskModule;

function loadVosk() {
  if (voskModule !== undefined) return voskModule;
  try {
    // Optional native dependency: only required when the offline engine is used.
    voskModule = require('vosk');
  } catch {
    voskModule = null;
  }
  return voskModule;
}

function listVoskModels() {
  const roots = [
    path.join(os.homedir(), 'Documents', 'Shine', 'models'),
    path.join(appUserDataSafe(), 'models'),
    path.join(process.cwd(), 'resources', 'models'),
  ];
  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(full, 'am'))) found.push({ name: entry.name, path: full });
      else {
        try {
          for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
            const subFull = path.join(full, sub.name);
            if (sub.isDirectory() && fs.existsSync(path.join(subFull, 'am'))) {
              found.push({ name: `${entry.name}/${sub.name}`, path: subFull });
            }
          }
        } catch {}
      }
    }
  }
  return found;
}

function appUserDataSafe() {
  try {
    return require('electron').app.getPath('userData');
  } catch {
    return path.join(os.homedir(), '.shine');
  }
}

function resolveVoskModel(modelPath) {
  if (modelPath && fs.existsSync(path.join(modelPath, 'am'))) return modelPath;
  const models = listVoskModels();
  if (models.length) return models[0].path;
  return null;
}

async function transcribeWithVosk({ wav, modelPath, signal }) {
  const vosk = loadVosk();
  if (!vosk) {
    throw new Error('Offline dictation is not installed. Run "npm install vosk" in the project folder, then download a Vosk model into Documents\\Shine\\models.');
  }
  const resolved = resolveVoskModel(modelPath);
  if (!resolved) {
    throw new Error(
      'No offline speech model found. Download a Vosk model (for example vosk-model-small-en-us-0.15) and unzip it into Documents\\Shine\\models, then pick it in Settings.'
    );
  }

  let model;
  let recognizer;
  try {
    vosk.setLogLevel(-1);
    model = await new Promise((resolve, reject) => {
      const m = new vosk.Model(resolved);
      m.on('ready', () => resolve(m));
      m.on('error', reject);
    });
    recognizer = new model.KaldiRecognizer(16000);
    recognizer.setWords(false);
  } catch (err) {
    throw new Error(`Could not load the Vosk model at ${resolved}: ${err?.message || err}`);
  }

  const pcm = wav.subarray(44);
  const CHUNK = 8000;
  let text = '';
  try {
    for (let i = 0; i < pcm.length; i += CHUNK) {
      if (signal?.aborted) throw new Error('Dictation was cancelled.');
      const slice = pcm.subarray(i, Math.min(i + CHUNK, pcm.length));
      await new Promise((resolve, reject) => {
        recognizer.on('result', (msg) => {
          if (msg?.result?.text) text += `${msg.result.text} `;
          resolve();
        });
        recognizer.on('partialresult', () => {});
        recognizer.on('error', reject);
        recognizer.acceptWaveform(slice);
      });
    }
    const final = await new Promise((resolve) => {
      recognizer.on('result', (msg) => resolve(msg?.result?.text || ''));
      recognizer.retrieveFinalResult();
    });
    if (final) text += `${final} `;
  } finally {
    try {
      recognizer?.free();
    } catch {}
    try {
      await new Promise((resolve) => {
        model.remove();
        resolve();
      });
    } catch {}
  }

  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('No speech was detected. Hold the mic button while you talk, then release.');
  return { text: clean, engine: 'vosk', model: path.basename(resolved) };
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Turn a recorded clip into text.
 * Never throws: always resolves to { text, engine } or { error }.
 */
async function transcribe({ audioBase64, engine, model, language, modelPath, credentials, signal }) {
  try {
    const wav = Buffer.from(String(audioBase64 || ''), 'base64');
    if (wav.length < 1000) throw new Error('That recording was too short. Hold the mic button while you speak.');

    const started = Date.now();
    const result =
      engine === 'vosk'
        ? await transcribeWithVosk({ wav, modelPath, signal })
        : await transcribeWithApi({ wav, credentials, model, language, signal });

    return { ...result, durationMs: Date.now() - started, bytes: wav.length };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

async function downloadModel(url, destinationName, onProgress) {
  const vosk = loadVosk();
  if (!vosk) throw new Error('Offline dictation needs the optional "vosk" package. Run: npm install vosk');

  const dir = path.join(os.homedir(), 'Documents', 'Shine', 'models');
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, destinationName);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length') || 0);
  const tmp = `${target}.download`;
  const out = fs.createWriteStream(tmp);
  let received = 0;

  try {
    for await (const chunk of res.body) {
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress?.(received, total);
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    await extractArchive(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
  return target;
}

/** Minimal ZIP extractor (stored + deflate entries only), so we avoid a dependency. */
async function extractArchive(archivePath, destination) {
  const buf = await fsp.readFile(archivePath);
  const zlib = require('node:zlib');

  // Try tar.gz next (Vosk publishes .zip on the model board; .tar.gz elsewhere).
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const { spawn } = require('node:child_process');
    await new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xzf', archivePath, '-C', destination], { windowsHide: true });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))));
    });
    return destination;
  }

  const EOCD = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (EOCD < 0) throw new Error('That file is not a zip or tar.gz archive.');
  const entryCount = buf.readUInt16LE(EOCD + 10);
  let offset = buf.readUInt32LE(EOCD + 16);

  await fsp.mkdir(destination, { recursive: true });
  for (let i = 0; i < entryCount; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;

    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    const outPath = path.join(destination, name);
    if (!path.resolve(outPath).startsWith(path.resolve(destination))) continue; // zip slip
    if (name.endsWith('/')) {
      await fsp.mkdir(outPath, { recursive: true });
      continue;
    }
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    const content = method === 0 ? data : zlib.inflateRawSync(data);
    await fsp.writeFile(outPath, content);
  }
  return destination;
}

function voskInstalled() {
  return Boolean(loadVosk());
}

module.exports = { transcribe, listVoskModels, voskInstalled, downloadModel, pcmToWav };