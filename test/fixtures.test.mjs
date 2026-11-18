// Runs every fixture page: planted jank must be found, clean pages must stay silent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const probe = join(root, 'skills/antijank/scripts/probe.js');
const fixtures = readdirSync(join(root, 'fixtures')).filter((f) => f.endsWith('.html')).sort();
const only = process.env.FIXTURE;

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

for (const name of fixtures) {
  if (only && !name.includes(only)) continue;
  test(name, async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.goto(pathToFileURL(join(root, 'fixtures', name)).href);
      await page.addScriptTag({ path: probe });
      const { result, report, expect } = await page.evaluate(async () => {
        const result = await window.antijank.record(() => window.trigger(), window.OPTIONS || {});
        const e = window.EXPECT;
        return {
          result,
          report: window.antijank.report(),
          expect: { ...e, cause: e.cause ? e.cause.source : null },
        };
      });
      const types = result.findings.map((f) => f.type);
      const why = `\n${report}\n`;
      assert.notEqual(result.status, 'error', result.error);
      if (expect.none) assert.deepEqual(types, [], `expected no findings${why}`);
      for (const t of expect.has || []) assert.ok(types.includes(t), `expected a "${t}" finding${why}`);
      if (expect.allow || expect.has) {
        const ok = new Set([...(expect.has || []), ...(expect.allow || [])]);
        const extra = types.filter((t) => !ok.has(t));
        assert.deepEqual(extra, [], `unexpected findings${why}`);
      }
      // Expectations named in EXPECT.failing must fail; every other one must pass.
      const failing = new Set(expect.failing || []);
      for (const name of failing)
        assert.ok((result.expectations || []).some((e) => e.name === name), `expected an expectation named "${name}"${why}`);
      for (const e of result.expectations || [])
        assert.equal(e.pass, !failing.has(e.name), `expectation ${e.pass ? 'passed' : 'failed'}: ${e.name}: ${e.detail}${why}`);
      if (expect.message)
        assert.ok(result.findings.some((f) => f.message.includes(expect.message)), `expected a message with "${expect.message}"${why}`);
      if (expect.loops) assert.ok((result.loops || []).length > 0, `expected a loop to be left out${why}`);
      if (expect.cause) {
        const re = new RegExp(expect.cause);
        assert.ok(result.findings.some((f) => re.test(f.cause || '')), `expected a cause matching ${re}${why}`);
      }
      if (process.env.VERBOSE) console.log(name + why);
    } finally {
      await page.close();
    }
  });
}
