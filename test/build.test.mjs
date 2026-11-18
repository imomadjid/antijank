// The minified probe, the version strings and the pinned CDN loader in SKILL.md stay in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { minify, SOURCE, MINIFIED } from '../scripts/build.mjs';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const skill = readFileSync(join(root, 'skills/antijank/SKILL.md'), 'utf8');

test('probe.min.js is built from the current probe.js (run pnpm build)', async () => {
  assert.equal(readFileSync(MINIFIED, 'utf8'), await minify());
});

test('the probe reports the package version', () => {
  assert.match(readFileSync(SOURCE, 'utf8'), new RegExp(`const VERSION = '${pkg.version.replace(/\./g, '\\.')}';`));
});

test('the CDN loader in SKILL.md pins this version and the hash of probe.min.js', () => {
  const url = skill.match(/cdn\.jsdelivr\.net\/npm\/antijank@([^/]+)\/skills\/antijank\/scripts\/probe\.min\.js/);
  assert.ok(url, 'no CDN loader in SKILL.md');
  assert.equal(url[1], pkg.version);
  const sri = 'sha384-' + createHash('sha384').update(readFileSync(MINIFIED)).digest('base64');
  assert.ok(skill.includes(`s.integrity = '${sri}'`), `SKILL.md integrity should be ${sri}`);
});

test('the minified probe finds the same jank as the source', async () => {
  const browser = await chromium.launch();
  try {
    const run = async (probe) => {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.goto(`file://${join(root, 'fixtures/push-shift.html')}`);
      await page.addScriptTag({ path: probe });
      const r = await page.evaluate(() => antijank.record(() => trigger()));
      await page.close();
      return r.findings.map((f) => `${f.type} ${f.element}`).sort();
    };
    const [src, min] = [await run(SOURCE), await run(MINIFIED)];
    assert.ok(src.length > 0);
    assert.deepEqual(min, src);
  } finally {
    await browser.close();
  }
});

test('the CDN loader in SKILL.md loads the probe, and refuses a different file', async () => {
  const snippet = skill.match(/```js\n(await new Promise\(\(ok, fail\) => \{[\s\S]*?\n\}\);)\n```/)[1];
  const browser = await chromium.launch();
  try {
    const load = async (body) => {
      const page = await browser.newPage();
      await page.route('https://cdn.jsdelivr.net/**', (r) =>
        r.fulfill({ body, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } })
      );
      await page.route('http://page.test/', (r) => r.fulfill({ body: '<!doctype html><title>t</title>', contentType: 'text/html' }));
      await page.goto('http://page.test/');
      const out = await page.evaluate(`(async () => { try { ${snippet} return window.antijank.version; } catch (e) { return e.message; } })()`);
      await page.close();
      return out;
    };
    assert.equal(await load(readFileSync(MINIFIED)), pkg.version);
    assert.match(await load(readFileSync(MINIFIED, 'utf8') + '\n// tampered'), /CDN script blocked/);
  } finally {
    await browser.close();
  }
});
