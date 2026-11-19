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
  assert.match(r.stdout, /✗ still others: 4 moved more than 1px\n  div\.row "a" 44px/);
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
  assert.match(r.stdout, /seen in: normal 1\/1 · cpu×4 1\/1 · reduced motion 1\/1/);
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

test('a record block settles only after its last step', () => {
  const steps = JSON.stringify([{ record: [{ wait: 600 }, { eval: 'trigger()' }] }]);
  const r = run(fixture('pop-in.html'), '--steps', steps);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /appeared at full opacity/);
});

test('--click with --steps is a setup error', () => {
  const r = run(fixture('pop-in.html'), '--click', 'body', '--steps', trigger);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--click or --steps/);
});

test('a click that leaves the page is a named setup error', () => {
  const r = run(fixture('nav-link.html'), '--click', '#go');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /step 1 .* navigated to .*pop-in\.html/);
});

// Real input makes Chromium render several frames back to back; a one-frame glitch behind a
// real click must still be caught, also with a slow CPU.
for (const cpu of ['1', '4']) {
  test(`a one-frame late FLIP behind a real click is caught (cpu ×${cpu})`, () => {
    const r = run(fixture('late-flip-click.html'), '--click', '#add', '--cpu', cpu, '--runs', '3');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /snapped back\n +seen in: (cpu×\d|normal) 3\/3/);
  });
}

test('a real click that shows nothing for 250ms is a slow response', () => {
  const r = run(fixture('slow-response.html'), '--click', '#btn');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /button#btn\n +took \d+ms to show any response to the click/);
});

test('a real click answered at once is not a slow response', () => {
  const r = run(fixture('clean-fast-response.html'), '--click', '#btn');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /response/);
});

test('a hover transition under the pointer does not hide a slow response', () => {
  const r = run(fixture('slow-response-hover.html'), '--click', '#btn');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /took \d+ms to show any response to the click/);
});

test('the report and the matrix summary fit in 72 columns, with no colour codes when piped', () => {
  const r = run(fixture('remount-gap.html'), '--steps', trigger, '--expect', '{"still":"others"}', '--matrix');
  const lines = r.stdout.trimEnd().split('\n');
  assert.ok(lines.length > 5);
  for (const line of lines) assert.ok(line.length <= 72, `too wide (${line.length}): ${line}`);
  assert.doesNotMatch(r.stdout, /\x1b\[/);
});

test('FORCE_COLOR colours severities for a terminal', () => {
  const r = spawnSync(process.execPath, [join(root, 'skills/antijank/scripts/run.mjs'), fixture('push-shift.html'), '--steps', trigger], {
    cwd: root,
    encoding: 'utf8',
    env: Object.fromEntries([...Object.entries(process.env).filter(([k]) => k !== 'NO_COLOR'), ['FORCE_COLOR', '1']]),
  });
  assert.match(r.stdout, /\x1b\[1m\x1b\[31mHIGH/);
});
