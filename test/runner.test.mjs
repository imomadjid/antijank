// The runner's exit codes and output, end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (...args) => spawnSync(process.execPath, [join(root, 'skills/antijank/scripts/run.mjs'), ...args], { cwd: root, encoding: 'utf8' });
const fixture = (name) => join(root, 'fixtures', name);
const trigger = JSON.stringify([{ record: [{ eval: 'trigger()' }] }]);

test('clean page: no findings, exit 0', () => {
  const r = run(fixture('clean-spring.html'), '--steps', trigger);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no jank found/);
});

test('failed expectation: exit 1 and names the movers', () => {
  const r = run(fixture('push-shift.html'), '--steps', trigger, '--expect', '{"still":"others"}');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /expect ✗ still others/);
  assert.match(r.stdout, /cause: div#banner inserted/);
});

test('--fail-on high trips on a blip', () => {
  const r = run(fixture('flip-flash.html'), '--steps', trigger, '--fail-on', 'high');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /snapped back/);
});

test('--matrix compares conditions', () => {
  const r = run(fixture('flip-flash.html'), '--steps', trigger, '--matrix');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /normal 1\/1, cpu×4 1\/1, reduced motion 1\/1/);
});

test('records a page load by default', () => {
  const r = run(fixture('clean-fade-slide.html'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /antijank \d/);
});

test('probe-path prints the probe location', () => {
  const r = run('probe-path');
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /probe\.js$/);
});
