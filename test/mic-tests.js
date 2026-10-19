'use strict';

/**
 * Dictation pipeline checks. Run with: node test/mic-tests.js
 *
 * Requires the mock provider on 127.0.0.1:8787 (node test/mock-provider.js),
 * which stands in for a Whisper-compatible transcription endpoint.
 */

const stt = require('../src/main/mic/stt');

const MOCK = process.env.SHINE_TEST_BASEURL || 'http://127.0.0.1:8787/v1';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

/** One second of a 440 Hz tone at 16 kHz, as a proper RIFF/WAVE buffer. */
function makeTone(seconds = 1, sampleRate = 16000) {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.4;
  }
  return stt.pcmToWav(samples, sampleRate);
}

(async () => {
  console.log('\nWAV encoding');
  const wav = makeTone(1);
  check('produces a RIFF header', wav.subarray(0, 4).toString('ascii') === 'RIFF');
  check('produces a WAVE format tag', wav.subarray(8, 12).toString('ascii') === 'WAVE');
  check('records fmt  chunk', wav.subarray(12, 16).toString('ascii') === 'fmt ');
  check('records data chunk', wav.subarray(36, 40).toString('ascii') === 'data');
  check('declares PCM mono 16-bit', wav.readUInt16LE(20) === 1 && wav.readUInt16LE(22) === 1 && wav.readUInt16LE(34) === 16);
  check('uses the requested sample rate', wav.readUInt32LE(24) === 16000, String(wav.readUInt32LE(24)));
  check('size matches the sample count', wav.length === 44 + 16000 * 2, String(wav.length));
  check('RIFF size field is consistent', wav.readUInt32LE(4) === wav.length - 8);

  console.log('\nTranscription guards');
  const tooShort = await stt.transcribe({ audioBase64: Buffer.alloc(10).toString('base64'), engine: 'api', credentials: { sttApiKey: 'k' } });
  check('rejects an empty recording', !tooShort.text && /too short/i.test(tooShort.error || ''), tooShort.error);

  const noKey = await stt.transcribe({ audioBase64: wav.toString('base64'), engine: 'api', credentials: {} });
  check('explains what is missing without a key', /API key/i.test(noKey.error || ''), noKey.error);

  const offlineMissing = await stt.transcribe({ audioBase64: wav.toString('base64'), engine: 'vosk' });
  check('gives an actionable message when no offline model exists', /vosk|model/i.test(offlineMissing.error || ''), offlineMissing.error);

  console.log('\nTranscription against the mock provider');
  const result = await stt.transcribe({
    audioBase64: wav.toString('base64'),
    engine: 'api',
    model: 'whisper-1',
    language: 'auto',
    credentials: { sttProvider: 'custom', sttBaseUrl: MOCK, sttApiKey: 'mock-key' },
  });
  check('returns the transcript', result.text === 'hello from the mock microphone', result.error);
  check('reports which engine ran', result.engine === 'api', result.engine);
  check('reports timing', typeof result.durationMs === 'number');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`failures:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
})();