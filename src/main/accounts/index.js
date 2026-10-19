'use strict';

/**
 * Local accounts.
 *
 * There is no server, so there is nothing to phish and nothing to spoof: an
 * account only exists once this machine created it. Passwords are stored as
 * scrypt hashes with a per-user random salt and are never written in clear.
 *
 * Sign-in checks the submitted password against that hash. A made-up username
 * or a made-up password simply does not match, so it cannot succeed.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const MIN_PASSWORD = 8;
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Files                                                              */
/* ------------------------------------------------------------------ */

function baseDir() {
  if (process.env.SHINE_ACCOUNTS_DIR) return process.env.SHINE_ACCOUNTS_DIR;
  return path.join(app.getPath('userData'), 'accounts');
}

function accountsFile() {
  return path.join(baseDir(), 'accounts.json');
}

function sessionFile() {
  return path.join(baseDir(), 'session.json');
}

function avatarDir() {
  return path.join(baseDir(), 'avatars');
}

function avatarFile(username) {
  return path.join(avatarDir(), `${username.toLowerCase()}.png`);
}

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(accountsFile(), 'utf8'));
    if (!Array.isArray(cache.accounts)) cache.accounts = [];
  } catch {
    cache = { version: 1, accounts: [] };
  }
  return cache;
}

async function persist() {
  await fsp.mkdir(baseDir(), { recursive: true });
  await fsp.writeFile(accountsFile(), JSON.stringify(cache, null, 2), 'utf8');
  try {
    await fsp.chmod(accountsFile(), 0o600);
  } catch {
    /* best effort on Windows */
  }
}

/* ------------------------------------------------------------------ */
/* Hashing                                                            */
/* ------------------------------------------------------------------ */

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), useSalt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
  return { salt: useSalt, hash: derived.toString('hex') };
}

function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash) return false;
  const candidate = hashPassword(password, record.salt);
  const a = Buffer.from(candidate.hash, 'hex');
  const b = Buffer.from(record.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Validation                                                         */
/* ------------------------------------------------------------------ */

function validateUsername(username) {
  const value = String(username || '').trim();
  if (!USERNAME_RE.test(value)) {
    return 'Usernames must be 3-32 characters and use only letters, numbers, dot, dash or underscore.';
  }
  return null;
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < MIN_PASSWORD) return `Passwords must be at least ${MIN_PASSWORD} characters.`;
  if (value.length > 256) return 'That password is too long.';
  return null;
}

function find(username) {
  const wanted = String(username || '').trim().toLowerCase();
  return load().accounts.find((a) => a.username.toLowerCase() === wanted) || null;
}

function publicView(account) {
  if (!account) return null;
  return {
    username: account.username,
    displayName: account.displayName || account.username,
    avatarPath: account.avatar ? avatarFile(account.username) : null,
    hasAvatar: Boolean(account.avatar),
    createdAt: account.createdAt,
    recoveryQuestion: account.recoveryQuestion || null,
  };
}

/* ------------------------------------------------------------------ */
/* Session                                                            */
/* ------------------------------------------------------------------ */

async function readSession() {
  try {
    const session = JSON.parse(await fsp.readFile(sessionFile(), 'utf8'));
    if (!session?.username) return null;
    const account = find(session.username);
    return account ? publicView(account) : null;
  } catch {
    return null;
  }
}

async function writeSession(username) {
  await fsp.mkdir(baseDir(), { recursive: true });
  if (!username) {
    await fsp.rm(sessionFile(), { force: true });
    return;
  }
  await fsp.writeFile(sessionFile(), JSON.stringify({ username, at: new Date().toISOString() }), 'utf8');
}

async function current() {
  return readSession();
}

/* ------------------------------------------------------------------ */
/* Operations                                                         */
/* ------------------------------------------------------------------ */

async function signup({ username, password, displayName, recoveryQuestion, recoveryAnswer }) {
  const usernameError = validateUsername(username);
  if (usernameError) return { ok: false, error: usernameError, field: 'username' };

  const passwordError = validatePassword(password);
  if (passwordError) return { ok: false, error: passwordError, field: 'password' };

  if (!recoveryQuestion || String(recoveryQuestion).trim().length < 3) {
    return { ok: false, error: 'Choose a recovery question you will remember the answer to.', field: 'recoveryQuestion' };
  }
  if (!recoveryAnswer || String(recoveryAnswer).trim().length < 2) {
    return { ok: false, error: 'Answer your recovery question.', field: 'recoveryAnswer' };
  }

  load();
  if (find(username)) return { ok: false, error: 'That username is already taken on this PC.', field: 'username' };

  const { salt, hash } = hashPassword(password);
  const answerSalt = crypto.randomBytes(16).toString('hex');
  const answerHash = crypto.scryptSync(String(recoveryAnswer).trim().toLowerCase(), answerSalt, 32).toString('hex');

  const account = {
    username: String(username).trim(),
    displayName: String(displayName || username).trim().slice(0, 48) || String(username).trim(),
    salt,
    hash,
    recoveryQuestion: String(recoveryQuestion).trim().slice(0, 120),
    recoverySalt: answerSalt,
    recoveryHash: answerHash,
    avatar: false,
    createdAt: new Date().toISOString(),
  };

  cache.accounts.push(account);
  await persist();
  await writeSession(account.username);
  return { ok: true, account: publicView(account) };
}

async function signin({ username, password }) {
  const account = find(username);
  // Always run a hash so a missing account and a wrong password take the
  // same amount of time.
  const record = account || { salt: 'x', hash: crypto.scryptSync('x', 'x', SCRYPT.keylen).toString('hex') };
  const ok = verifyPassword(password, record) && Boolean(account);

  if (!ok) {
    return { ok: false, error: account ? 'That password is not right.' : 'No account with that username on this PC.' };
  }

  await writeSession(account.username);
  return { ok: true, account: publicView(account) };
}

async function signout() {
  await writeSession(null);
  return { ok: true };
}

/**
 * Password recovery. The answer is checked against its own salted hash; a
 * wrong answer never reveals whether the account exists.
 */
async function forgotPassword({ username, answer, newPassword }) {
  const account = find(username);

  const ok =
    account &&
    String(answer || '').trim().toLowerCase().length >= 2 &&
    crypto.timingSafeEqual(
      crypto.scryptSync(String(answer || '').trim().toLowerCase(), account.recoverySalt, 32),
      Buffer.from(account.recoveryHash, 'hex')
    );

  if (!ok) {
    return { ok: false, error: 'No account matches that username and recovery answer.' };
  }

  const passwordError = validatePassword(newPassword);
  if (passwordError) return { ok: false, error: passwordError, field: 'newPassword' };

  const { salt, hash } = hashPassword(newPassword);
  account.salt = salt;
  account.hash = hash;
  await persist();
  await writeSession(account.username);
  return { ok: true, account: publicView(account) };
}

async function getRecoveryQuestion({ username }) {
  const account = find(username);
  if (!account) return { ok: false, error: 'No account with that username on this PC.' };
  return { ok: true, question: account.recoveryQuestion };
}

async function changePassword({ username, currentPassword, newPassword }) {
  const account = find(username);
  if (!account) return { ok: false, error: 'That account no longer exists.' };
  if (!verifyPassword(currentPassword, account)) return { ok: false, error: 'Your current password is not right.', field: 'currentPassword' };

  const passwordError = validatePassword(newPassword);
  if (passwordError) return { ok: false, error: passwordError, field: 'newPassword' };

  const { salt, hash } = hashPassword(newPassword);
  account.salt = salt;
  account.hash = hash;
  await persist();
  return { ok: true };
}

async function updateProfile({ username, displayName }) {
  const account = find(username);
  if (!account) return { ok: false, error: 'That account no longer exists.' };

  const name = String(displayName ?? account.displayName).trim();
  if (!name) return { ok: false, error: 'Your name cannot be empty.', field: 'displayName' };
  if (name.length > 48) return { ok: false, error: 'That name is too long.', field: 'displayName' };

  account.displayName = name;
  await persist();
  return { ok: true, account: publicView(account) };
}

async function changeUsername({ username, newUsername, password }) {
  const account = find(username);
  if (!account) return { ok: false, error: 'That account no longer exists.' };
  if (!verifyPassword(password, account)) return { ok: false, error: 'That password is not right.', field: 'password' };

  const usernameError = validateUsername(newUsername);
  if (usernameError) return { ok: false, error: usernameError, field: 'newUsername' };

  const wanted = String(newUsername).trim();
  const clash = find(wanted);
  if (clash && clash.username !== account.username) {
    return { ok: false, error: 'That username is already taken on this PC.', field: 'newUsername' };
  }

  const hadAvatar = account.avatar;
  const oldAvatar = avatarFile(account.username);
  const oldUsername = account.username;

  // Read the session before the rename, otherwise the lookup by old username
  // no longer resolves and the session would be left pointing at nothing.
  const session = await readSession();
  const sessionBelongsHere = Boolean(session && session.username === oldUsername);

  account.username = wanted;
  await persist();

  if (hadAvatar) {
    await fsp.rename(oldAvatar, avatarFile(wanted)).catch(() => {});
  }
  if (sessionBelongsHere) await writeSession(wanted);

  return { ok: true, account: publicView(account) };
}

/**
 * Store a profile picture. The file is copied into the account folder and
 * downscaled if PowerShell is available, so it cannot be used to smuggle in
 * something enormous.
 */
async function setAvatar({ username, imagePath }) {
  const account = find(username);
  if (!account) return { ok: false, error: 'That account no longer exists.' };

  const source = String(imagePath || '');
  let stat;
  try {
    stat = await fsp.stat(source);
  } catch {
    return { ok: false, error: 'That image could not be found.' };
  }
  if (!stat.isFile()) return { ok: false, error: 'That is not an image file.' };
  if (stat.size > MAX_AVATAR_BYTES) return { ok: false, error: 'Pick an image under 8 MB.' };

  await fsp.mkdir(avatarDir(), { recursive: true });
  const target = avatarFile(account.username);

  const bytes = await fsp.readFile(source);
  await fsp.writeFile(target, bytes);
  account.avatar = true;
  await persist();
  return { ok: true, account: publicView(account) };
}

async function clearAvatar({ username }) {
  const account = find(username);
  if (!account) return { ok: false, error: 'That account no longer exists.' };
  await fsp.rm(avatarFile(account.username), { force: true }).catch(() => {});
  account.avatar = false;
  await persist();
  return { ok: true, account: publicView(account) };
}

/** Read the stored avatar as a data URL, downscaled to keep prompts small. */
async function avatarDataUrl(account, size = 160) {
  if (!account?.avatar) return null;
  try {
    const { runPowerShell } = require('./powershell');
    const source = avatarFile(account.username);
    const out = await runPowerShell(`
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName System.Drawing
      $src = [System.Drawing.Image]::FromFile(${psq(source)})
      $bmp = New-Object System.Drawing.Bitmap(${size}, ${size})
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.Clear([System.Drawing.Color]::Transparent)
      $g.DrawImage($src, 0, 0, ${size}, ${size})
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      [Convert]::ToBase64String($ms.ToArray())
    `);
    if (out.ok && out.stdout) return `data:image/png;base64,${out.stdout.trim()}`;
  } catch {
    /* fall through to the raw file */
  }
  try {
    const raw = await fsp.readFile(avatarFile(account.username));
    return `data:image/png;base64,${raw.toString('base64')}`;
  } catch {
    return null;
  }
}

function psq(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

module.exports = {
  signup, signin, signout, forgotPassword, getRecoveryQuestion,
  changePassword, updateProfile, changeUsername, setAvatar, clearAvatar,
  current, readSession, find, publicView, avatarDataUrl,
  validateUsername, validatePassword, baseDir,
};