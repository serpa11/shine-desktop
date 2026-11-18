'use strict';

/**
 * The Linux shell bridge.
 *
 * These run on a Windows machine, where none of the code under test will
 * actually execute - which is the point. Everything asserted here is either a
 * pure function (the wrapper text, the quoting, the shell choice) or a value
 * runCommand() reports identically whether or not a POSIX shell exists. That
 * keeps the suite meaningful without a Linux box; the real thing gets
 * exercised when the app is dual-booted, and until then this is what pins the
 * contract.
 *
 * Run with: node test/linux-shell-tests.js
 */

const linux = require('../src/main/agent/platform/linux');

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

function section(title) {
  console.log(`\n${title}`);
}

section('Linux: the script wrapper');

{
  const plain = linux.shWrapper('echo hi');
  check('failure is made terminating', plain.includes('set -e'), JSON.stringify(plain));
  check('the command runs last', plain.trim().endsWith('echo hi'), JSON.stringify(plain));
  check('pipefail stays out by default', !plain.includes('pipefail'), JSON.stringify(plain));

  const piped = linux.shWrapper('a | b', { pipefail: true });
  check('pipefail is opted into when asked', piped.includes('set -o pipefail'), JSON.stringify(piped));
  check('the command still runs last under pipefail', piped.trim().endsWith('a | b'), JSON.stringify(piped));

  // dash is /bin/sh on Debian and Ubuntu, and it rejects pipefail outright
  // with "Illegal option -o pipefail" - which would kill every command
  // before it ran. This is the assertion that keeps that mistake out.
  const sh = linux.shWrapper('echo hi', { pipefail: false });
  check('the sh wrapper never carries pipefail', !sh.includes('pipefail'), JSON.stringify(sh));

  const multi = linux.shWrapper('false; echo ok');
  check('a multi-line command is passed through untouched', multi.endsWith('false; echo ok'), JSON.stringify(multi));
}

section('Linux: quoting');

{
  check('a plain word is quoted', linux.shellQuote('hello') === "'hello'", linux.shellQuote('hello'));
  check('spaces stay inside the quotes', linux.shellQuote('a b') === "'a b'", linux.shellQuote('a b'));

  // The POSIX way to put an apostrophe inside single quotes is to close the
  // quote, escape it, and reopen: 'it'\''s'. Getting this wrong silently
  // truncates the argument at the first quote, which is how a path like
  // C:\Users\O'Brien would turn into a wrong-path error.
  const escaped = linux.shellQuote("it's");
  check("a single quote is escaped the POSIX way", escaped === "'it'\\''s'", escaped);

  check('a dollar sign cannot expand', linux.shellQuote('$HOME') === "'$HOME'", linux.shellQuote('$HOME'));
  check('a backtick cannot run a command', linux.shellQuote('`id`') === "'`id`'", linux.shellQuote('`id`'));
  check('an empty value still quotes', linux.shellQuote('') === "''", JSON.stringify(linux.shellQuote('')));
}

section('Linux: shell choice');

{
  const sh = linux.pickShell('sh');
  check('sh is honoured', sh.name === 'sh' && sh.pipefail === false, JSON.stringify(sh));

  const bash = linux.pickShell('bash');
  check('bash is honoured', bash.name === 'bash' && bash.pipefail === true, JSON.stringify(bash));

  check('nothing asked for means bash', linux.pickShell().name === 'bash', JSON.stringify(linux.pickShell()));
  check('an empty shell means bash', linux.pickShell('').name === 'bash');
  check('a Windows shell name falls back instead of failing', linux.pickShell('powershell').name === 'bash');
  check('an unrecognised shell falls back instead of failing', linux.pickShell('fish').name === 'bash');
}

section('Linux: what runCommand reports');

(async () => {
  // Only what runCommand() *reports* is asserted. Whether sh actually exists
  // differs between this machine and the one the code is written for, and
  // asserting on ok would make the suite pass for the wrong reason on one of
  // them.
  const res = await linux.runCommand('echo hi', { shell: 'sh' });
  check('runCommand reports the shell it used', res.shell === 'sh', res.shell);
  check('runCommand always returns an exit code', typeof res.code === 'number', JSON.stringify(res));
  check('runCommand always returns strings', typeof res.stdout === 'string' && typeof res.stderr === 'string');
  check('runCommand always reports ok as a boolean', typeof res.ok === 'boolean', JSON.stringify(res));
  check('runCommand always reports timedOut', typeof res.timedOut === 'boolean', JSON.stringify(res));

  // cmd/PowerShell classification does not exist on Linux: an && chain is
  // simply a command there, and must not be routed or retried anywhere.
  const chained = await linux.runCommand('true && echo ok', { shell: 'sh' });
  check('an && chain is simply a command', chained.shell === 'sh', chained.shell);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`failures:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
})();
