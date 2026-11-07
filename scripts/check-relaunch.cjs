#!/usr/bin/env node
/*
 * Packaged relaunch check (issue #12).
 *
 * Reads the markers written by `--relaunch-probe` in a packaged Windows build and
 * proves that the relaunch target was the portable EXE, not the temporary
 * extraction directory Electron runs from.
 *
 * Note on what the child reports: a portable build always starts from a fresh
 * extraction directory, so `child.execPath` is *not* the portable EXE — that is
 * exactly why relaunching `process.execPath` is wrong. The portable launcher
 * re-establishes the origin, so the discriminating check is that the child still
 * reports `PORTABLE_EXECUTABLE_FILE` as the portable EXE. Relaunching the inner
 * copy instead would leave that variable empty.
 *
 *   node scripts/check-relaunch.cjs <marker-dir> <portable-exe> [timeout-seconds]
 *
 * Exits non-zero when the child never started, when it started from another
 * executable, or when the recorded decision was not "portable".
 */
'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const [directory, portableArg, timeoutArg] = process.argv.slice(2);
if (directory === undefined || portableArg === undefined) {
  console.error('usage: check-relaunch.cjs <marker-dir> <portable-exe> [timeout-seconds]');
  process.exit(2);
}

const portable = resolve(portableArg);
const timeoutMs = (Number.parseInt(timeoutArg ?? '120', 10) || 120) * 1000;
const read = (name) => {
  const file = join(directory, name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const samePath = (left, right) =>
  typeof left === 'string' && resolve(left).toLowerCase() === resolve(right).toLowerCase();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`);
};

const deadline = Date.now() + timeoutMs;
let parent = read('parent.json');
while (parent === null && Date.now() < deadline) {
  // The parent writes its marker immediately; a missing one means it never ran.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  parent = read('parent.json');
}

if (parent === null) {
  check('the packaged EXE starts and records its own path', false, 'parent.json is missing');
} else {
  check('the packaged EXE starts and records its own path', true);
  check('the running build reports the portable EXE as its origin', samePath(parent.portable, portable), String(parent.portable));
  const decision = read('decision.json');
  check('the relaunch decision targets the portable EXE', decision?.ok === true && decision?.target?.portable === true, JSON.stringify(decision));
  check(
    'the relaunch target is the file the user started',
    decision?.ok === true && samePath(decision?.target?.execPath, portable),
    JSON.stringify(decision?.target),
  );
}

let child = read('child.json');
while (child === null && Date.now() < deadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  child = read('child.json');
}

if (child === null) {
  check('the relaunched instance starts', false, 'child.json is missing');
} else {
  check('the relaunched instance starts', true);
  check('it is a new process, not the probe that relaunched it', child.pid !== parent?.pid, `${child.pid} vs ${parent?.pid}`);
  // The portable launcher re-extracts and starts the inner copy, so `execPath`
  // is a temp path by design; a child started from the inner copy directly would
  // have no portable origin at all.
  check(
    'it was started by the portable EXE, not by the inner extraction copy',
    samePath(child.portable, portable),
    `portable=${String(child.portable)} execPath=${String(child.execPath)}`,
  );
}

const failed = results.filter((result) => !result.ok);
console.log(`relaunch check: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
