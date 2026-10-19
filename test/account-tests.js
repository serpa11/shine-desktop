'use strict';

/**
 * Account tests. Run with: node test/account-tests.js
 *
 * The point of these is that a made-up username and password can never sign
 * in, passwords are never stored in clear, and the profile really does end up
 * in an outgoing provider request.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shine-accounts-'));
process.env.SHINE_ACCOUNTS_DIR = tmp;

const accounts = require('../src/main/accounts');
const profile = require('../src/main/profile');

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

(async () => {
  console.log('\nSigning up');
  const created = await accounts.signup({
    username: 'sam',
    password: 'correct horse battery',
    displayName: 'Sam Rivera',
    recoveryQuestion: 'First street you lived on',
    recoveryAnswer: 'Alder Way',
  });
  check('creates an account', created.ok, created.error);
  check('returns the display name', created.account?.displayName === 'Sam Rivera');
  check('signs the new account in', (await accounts.current())?.username === 'sam');

  console.log('\nA made-up login cannot work');
  check('rejects an unknown username', !(await accounts.signin({ username: 'not-a-user', password: 'whatever123' })).ok);
  check('rejects a wrong password', !(await accounts.signin({ username: 'sam', password: 'wrongpassword' })).ok);
  check('rejects an empty password', !(await accounts.signin({ username: 'sam', password: '' })).ok);
  const good = await accounts.signin({ username: 'sam', password: 'correct horse battery' });
  check('accepts the real credentials', good.ok, good.error);
  check('is case-insensitive on the username', (await accounts.signin({ username: 'SAM', password: 'correct horse battery' })).ok);

  console.log('\nDuplicates are refused');
  check('refuses a duplicate username', !(await accounts.signup({ username: 'sam', password: 'anotherpassword', recoveryQuestion: 'q?', recoveryAnswer: 'a' })).ok);
  check('refuses a short password', !(await accounts.signup({ username: 'other', password: 'short', recoveryQuestion: 'q?', recoveryAnswer: 'a' })).ok);
  check('refuses a bad username', !(await accounts.signup({ username: 'a b', password: 'longenough1', recoveryQuestion: 'q?', recoveryAnswer: 'a' })).ok);

  console.log('\nPasswords are never stored in clear');
  const raw = fs.readFileSync(path.join(tmp, 'accounts.json'), 'utf8');
  check('no clear password in the file', !raw.includes('correct horse battery'));
  check('a salt is stored', /"salt":\s*"[0-9a-f]{32}"/.test(raw));
  check('a scrypt hash is stored', /"hash":\s*"[0-9a-f]{128}"/.test(raw));

  console.log('\nForgotten password');
  const question = await accounts.getRecoveryQuestion({ username: 'sam' });
  check('returns the recovery question', question.ok && /First street/.test(question.question), question.error);
  check('rejects a wrong answer', !(await accounts.forgotPassword({ username: 'sam', answer: 'Wrong Street', newPassword: 'brand new password' })).ok);
  check('hides whether a username exists', !(await accounts.forgotPassword({ username: 'ghost', answer: 'Alder Way', newPassword: 'brand new password' })).ok);
  const reset = await accounts.forgotPassword({ username: 'sam', answer: 'Alder Way', newPassword: 'brand new password' });
  check('resets with the right answer', reset.ok, reset.error);
  check('old password no longer works', !(await accounts.signin({ username: 'sam', password: 'correct horse battery' })).ok);
  check('new password works', (await accounts.signin({ username: 'sam', password: 'brand new password' })).ok);

  console.log('\nChanging details');
  check('changes the name', (await accounts.updateProfile({ username: 'sam', displayName: 'Samuel R' })).account?.displayName === 'Samuel R');
  check('refuses an empty name', !(await accounts.updateProfile({ username: 'sam', displayName: '   ' })).ok);
  check('change username needs the password', !(await accounts.changeUsername({ username: 'sam', newUsername: 'samuel', password: 'nope1234' })).ok);
  check('changes the username', (await accounts.changeUsername({ username: 'sam', newUsername: 'samuel', password: 'brand new password' })).ok);
  check('session follows the rename', (await accounts.current())?.username === 'samuel');

  const second = await accounts.signup({
    username: 'other',
    password: 'a different password',
    displayName: 'Someone Else',
    recoveryQuestion: 'Favourite colour',
    recoveryAnswer: 'Blue',
  });
  check('a second account can exist', second.ok, second.error);
  check('signing up signs you into the new account', (await accounts.current())?.username === 'other');
  check('refuses a duplicate username', !(await accounts.changeUsername({ username: 'samuel', newUsername: 'other', password: 'brand new password' })).ok);
  check('sign back in as the first account', (await accounts.signin({ username: 'samuel', password: 'brand new password' })).ok);
  check('the account keeps its name after a refusal', (await accounts.current())?.username === 'samuel');

  console.log('\nProfile reaches the provider request');
  const ctx = await profile.build();
  check('builds a profile context', Boolean(ctx));
  check('mentions the name', /name: Samuel R/.test(ctx.text));
  check('mentions the username', /username: samuel/.test(ctx.text));

  const openaiBody = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] };
  check('applies to an OpenAI-style body', profile.apply('openai', openaiBody, ctx));
  check('adds a system message', openaiBody.messages[0].role === 'system');
  check('the system message names the user', /Samuel R/.test(openaiBody.messages[0].content));
  check('keeps the user message', openaiBody.messages[1].content === 'hello');

  const existing = { messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }] };
  profile.apply('openai', existing, ctx);
  check('merges into an existing system message', existing.messages[0].content.startsWith('You are helpful.') && /Samuel R/.test(existing.messages[0].content));
  check('does not add a second system message', existing.messages.filter((m) => m.role === 'system').length === 1);

  const claude = { model: 'claude', messages: [{ role: 'user', content: 'hello' }] };
  profile.apply('claude', claude, ctx);
  check('applies to Claude', /Samuel R/.test(claude.system));

  const gemini = { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] };
  profile.apply('gemini', gemini, ctx);
  check('applies to Gemini', /Samuel R/.test(gemini.systemInstruction.parts[0].text));

  console.log('\nProfile picture');
  check('no avatar yet', (await profile.build()).avatar === null);
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64'
  );
  const pic = path.join(tmp, 'face.jpg');
  fs.writeFileSync(pic, jpeg);
  check('stores a picture', (await accounts.setAvatar({ username: 'samuel', imagePath: pic })).ok);
  check('the account reports having one', (await accounts.current()).hasAvatar);
  check('removing it works', (await accounts.clearAvatar({ username: 'samuel' })).ok);
  check('the account reports having none', (await accounts.current()).hasAvatar === false);

  console.log('\nSigning out');
  await accounts.signout();
  check('signs out', (await accounts.current()) === null);
  check('no profile when signed out', (await profile.build()) === null);
  check('the account still exists after signing out', Boolean(accounts.find('samuel')));
  check('can sign back in', (await accounts.signin({ username: 'samuel', password: 'brand new password' })).ok);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`failures:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
})();