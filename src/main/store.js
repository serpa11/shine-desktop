'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * Desktop settings.
 *
 * Deliberately small: there is no settings UI in the app, so this only holds
 * what PC Control and dictation need to remember - the PC Control switch, its
 * step budget, the always-allow rules and the blocklist override.
 */

const DEFAULTS = {
  pcControl: {
    enabled: false,
    allowlist: [],
    allowReadOnlyWithoutPrompt: true,
    maxSteps: 8,
    dangerMode: false,
  },
  mic: {
    engine: 'api', // 'api' | 'vosk'
    language: 'auto',
    model: 'whisper-1',
    voskModelPath: '',
  },
  window: {
    width: 1180,
    height: 820,
    maximized: false,
  },
  app: {
    useRemoteSite: true,
    remoteUrl: 'https://shineai-9mr.pages.dev/',
    launchOnStartup: false,
  },
  telemetry: { activityLog: true },
};

let cache = null;
let filePath = null;

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(patch)) {
    const bv = out[key];
    const pv = patch[key];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && pv && typeof pv === 'object' && !Array.isArray(pv)) {
      out[key] = deepMerge(bv, pv);
    } else if (pv !== undefined) {
      out[key] = pv;
    }
  }
  return out;
}

function resolveFilePath() {
  if (filePath) return filePath;
  if (process.env.SHINE_DESKTOP_CONFIG) {
    filePath = path.resolve(process.env.SHINE_DESKTOP_CONFIG);
    return filePath;
  }
  filePath = path.join(app.getPath('userData'), 'shine-desktop.json');
  return filePath;
}

function load() {
  if (cache) return cache;
  try {
    cache = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(resolveFilePath(), 'utf8')));
  } catch {
    cache = JSON.parse(JSON.stringify(DEFAULTS));
  }
  return cache;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(resolveFilePath()), { recursive: true });
    fs.writeFileSync(resolveFilePath(), JSON.stringify(cache, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[store] failed to persist:', err.message);
    return false;
  }
}

module.exports = {
  defaults: DEFAULTS,
  get all() {
    return load();
  },
  get(section) {
    const s = load();
    return section === undefined ? s : s[section];
  },
  getValue(section, key, fallback) {
    const sec = load()[section];
    if (sec && Object.prototype.hasOwnProperty.call(sec, key)) return sec[key];
    return fallback;
  },
  set(section, patch) {
    load();
    cache[section] = deepMerge(cache[section] || {}, patch);
    persist();
    return cache[section];
  },
  setValue(section, key, value) {
    load();
    cache[section] = cache[section] || {};
    cache[section][key] = value;
    persist();
    return value;
  },
  filePath: resolveFilePath,
};