#!/usr/bin/env node
// antijank runner: opens a page in headless Chromium with the probe loaded, performs steps,
// and prints what moved or faded wrongly. Uses the Playwright already in your project.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PROBE = join(here, 'probe.js');

const HELP = `antijank: catch one-frame UI glitches (jumps, flashes, pop-ins, pushed neighbours)

Usage
  antijank <url> [options]                 record the page load
  antijank <url> --click <selector>        load, then record what a click does
  antijank <url> --steps <file|json>       run scripted steps (see below)
  antijank probe-path                      print the probe's path, to load it yourself

Options
  --click <sel>           click this, recording what follows
  --wait-for <sel>        only count the page as settled once this exists
  --root <sel>            watch only this part of the page (faster, less noise)
  --steps <file|json>     steps to run; a {"record": [...]} step records its inner steps
  --expect <file|json>    expectations, e.g. {"still":"others","fadesIn":[".toast"]}
  --cpu <n>               slow the CPU n times (Chromium)
  --viewport <WxH>        default 1280x800
  --mobile                375x812, touch
  --reduced-motion        emulate prefers-reduced-motion: reduce
  --matrix                run normal, --cpu 4 and reduced motion, and compare
  --runs <n>              repeat each condition n times (flaky findings show as k/n)
  --storage-state <file>  signed-in session saved by Playwright
  --timeout <ms>          longest a recording waits to settle (default 5000)
  --fail-on <severity>    exit 1 if a defect is at least high|medium|low (unanimated
                          changes don't count; require fades with --expect fadesIn)
  --json <file>           write every result as JSON
  --headed                show the browser
  -h, --help

Steps
  [{"goto": "/settings"},
   {"record": [{"click": "button[aria-label=Open]"}], "root": "main", "expect": {"still": "others"}},
   {"fill": ["input[name=q]", "lease"]}, {"press": "Enter"}, {"wait": 300}, {"waitFor": ".result"},
   {"hover": ".card"}, {"eval": "document.body.classList.add('dark')"}, {"reload": true}]
A record block that navigates (goto or reload) records the new page from its first frame.

Every step in a record block runs before the recording may settle.
Exit codes: 0 ok, 1 expectation failed or --fail-on hit, 2 setup error, hidden page or probe error.`;

const SEV = { high: 3, medium: 2, low: 1 };

// Setup errors end the run with exit code 2. Thrown rather than exiting at once, so output
// already written to a pipe is flushed.
class SetupError extends Error {}
function fail(msg) {
  throw new SetupError(msg);
}

const readJson = (v, what) => {
  if (v == null) return undefined;
  try {
    return JSON.parse(existsSync(v) ? readFileSync(v, 'utf8') : v);
  } catch (e) {
    fail(`could not read ${what}: ${e.message}`);
  }
};

async function loadPlaywright() {
  const tryFrom = async (base) => {
    const req = createRequire(join(base, 'noop.js'));
    for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
      try {
        const mod = await import(pathToFileURL(req.resolve(name)).href);
        const pw = mod.chromium ? mod : mod.default;
        if (pw && pw.chromium) return pw;
      } catch (_) {
        /* not here */
      }
    }
    return null;
  };
  return (await tryFrom(process.cwd())) || (await tryFrom(here));
}

function parse() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      click: { type: 'string' },
      'wait-for': { type: 'string' },
      root: { type: 'string' },
      steps: { type: 'string' },
      expect: { type: 'string' },
      cpu: { type: 'string' },
      viewport: { type: 'string' },
      mobile: { type: 'boolean' },
      'reduced-motion': { type: 'boolean' },
      matrix: { type: 'boolean' },
      runs: { type: 'string' },
      'storage-state': { type: 'string' },
      timeout: { type: 'string' },
      'fail-on': { type: 'string' },
      json: { type: 'string' },
      headed: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  return { values, positionals };
}

function stepsFor(url, v) {
  let steps = readJson(v.steps, '--steps');
  const shared = { root: v.root, waitFor: v['wait-for'], expect: readJson(v.expect, '--expect') };
  if (steps) {
    if (v.click) fail('use --click or --steps, not both (put the click in a record step)');
    if (!Array.isArray(steps)) fail('--steps must be a JSON array');
    if (!steps.some((s) => s.goto || s.reload)) steps = [{ goto: url }, ...steps];
    if (!steps.some((s) => s.record)) fail('--steps needs at least one {"record": [...]} step');
    return steps.map((s) => (s.record ? { ...shared, ...s } : s));
  }
  if (v.click) return [{ goto: url }, { ...shared, record: [{ click: v.click }] }];
  return [{ ...shared, record: [{ goto: url }] }];
}

async function act(page, step, base) {
  const at = (u) => new URL(u, base).href;
  if (step.goto) await page.goto(at(step.goto), { waitUntil: 'load' });
  else if (step.reload) await page.reload({ waitUntil: 'load' });
  else if (step.click) {
    // Hover first, as a person does, so hover styles start before the press, not with it.
    await page.hover(step.click);
    await page.waitForTimeout(150);
    await page.click(step.click);
  }
  else if (step.hover) await page.hover(step.hover);
  else if (step.fill) await page.fill(step.fill[0], step.fill[1]);
  else if (step.type) await page.locator(step.type[0]).pressSequentially(step.type[1]);
  else if (step.press) {
    if (Array.isArray(step.press)) await page.press(step.press[0], step.press[1]);
    else await page.keyboard.press(step.press);
  } else if (step.wait) await page.waitForTimeout(step.wait);
  else if (step.waitFor) await page.waitForSelector(step.waitFor);
  else if (step.eval) await page.evaluate(step.eval);
  else throw new Error(`unknown step: ${JSON.stringify(step)}`);
}

async function recordBlock(page, block, base, timeout) {
  // hold: settling waits until every step in the block has run, then release() starts it.
  const opts = {
    root: block.root,
    waitFor: block.waitFor,
    expect: block.expect,
    timeout: block.timeout || timeout,
    // Playwright's own step timeouts bound the block; this only catches a hang.
    holdTimeout: 10 * 60 * 1000,
    ...(block.options || {}),
    hold: true,
  };
  // The recording lives in one document. A marker set in it is checked after every step,
  // so a step that unexpectedly leaves the page is named instead of failing obscurely.
  const mark = Math.random().toString(36).slice(2);
  const setMark = () => page.evaluate((m) => (window.__antijankDoc = m), mark);
  const sameDoc = () => page.evaluate((m) => window.__antijankDoc === m, mark).catch(() => false);
  const runSteps = async (navigates) => {
    let marked = false;
    for (const [i, s] of block.record.entries()) {
      await act(page, s, base);
      if (s.goto || s.reload) {
        if (marked) throw new SetupError(`step ${i + 1} (${JSON.stringify(s)}) loads a second page; a record block records one page load. Put it in its own record block.`);
        await setMark();
        marked = true;
      } else if ((marked || !navigates) && !(await sameDoc())) {
        throw new SetupError(
          `step ${i + 1} (${JSON.stringify(s)}) navigated to ${page.url()}, which ends the recording. To record the new page, make that navigation a goto step in its own record block.`
        );
      }
    }
  };

  const nav = block.record.find((s) => s.goto || s.reload);
  let result;
  if (nav) {
    // Start on the first load of the target page only: not on iframes, other origins, or
    // later loads in the same block.
    const target = new URL(nav.goto ? new URL(nav.goto, base).href : page.url());
    const origin = target.protocol === 'file:' ? 'file://' : target.origin; // Chromium's file: origin
    const nonce = Math.random().toString(36).slice(2);
    await page.addInitScript(
      ({ nonce, opts, origin }) => {
        if (window.top !== window || location.origin !== origin) return;
        try {
          if (sessionStorage.getItem('antijank:' + nonce)) return;
          sessionStorage.setItem('antijank:' + nonce, '1');
        } catch (_) {
          /* storage blocked: record every load */
        }
        if (window.antijank) window.antijank.start(opts);
        else window.__antijankAutostart = opts;
      },
      { nonce, opts, origin }
    );
    await runSteps(true);
    const started = await page.evaluate(() => !!(window.antijank && (window.antijank.recording || window.antijank.result())));
    if (!started) throw new SetupError(`the recording never started on ${page.url()} (expected a page on ${origin})`);
  } else {
    await page.evaluate((o) => {
      window.antijank.start(o);
    }, opts);
    await setMark();
    await runSteps(false);
  }
  result = await page.evaluate(() => window.antijank.release());
  if (!result) throw new SetupError(`no recording result on ${page.url()}`);
  const report = await page.evaluate((r) => window.antijank.report(r), result);
  return { result, report };
}

async function runCondition(pw, url, steps, cond, v) {
  const browser = await pw.chromium.launch({ headless: !v.headed });
  try {
    const context = await browser.newContext({
      viewport: cond.viewport,
      isMobile: cond.mobile,
      hasTouch: cond.mobile,
      reducedMotion: cond.reducedMotion ? 'reduce' : 'no-preference',
      storageState: v['storage-state'] || undefined,
      // The probe is injected as a script; a strict Content-Security-Policy would block it.
      bypassCSP: true,
    });
    await context.addInitScript({ path: PROBE });
    const page = await context.newPage();
    if (cond.cpu > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cond.cpu });
    }
    const out = [];
    let n = 0;
    for (const step of steps) {
      if (step.record) {
        n++;
        out.push({ name: step.name || `recording ${n}`, ...(await recordBlock(page, step, url, cond.timeout)) });
      } else await act(page, step, url);
    }
    return out;
  } finally {
    await browser.close();
  }
}

async function main() {
  const { values: v, positionals } = parse();
  if (v.help || !positionals.length) {
    console.log(HELP);
    process.exitCode = v.help ? 0 : 2;
    return;
  }
  if (positionals[0] === 'probe-path') {
    console.log(PROBE);
    return;
  }
  let url = positionals[0];
  if (!/^[a-z]+:/i.test(url)) url = existsSync(url) ? pathToFileURL(resolve(url)).href : `http://${url}`;
  if (v['storage-state'] && !existsSync(v['storage-state'])) fail(`no storage state at ${v['storage-state']}`);
  if (v['fail-on'] && !SEV[v['fail-on']]) fail('--fail-on must be high, medium or low');

  const pw = await loadPlaywright();
  if (!pw)
    fail(
      'Playwright is not installed here. Add it to the project (e.g. `npm i -D playwright` or `pnpm add -D playwright`), then `npx playwright install chromium`.'
    );

  const [w, h] = (v.viewport || (v.mobile ? '375x812' : '1280x800')).split('x').map(Number);
  const base = { viewport: { width: w, height: h }, mobile: !!v.mobile, timeout: Number(v.timeout) || 5000 };
  const conditions = v.matrix
    ? [
        { ...base, name: 'normal', cpu: 1 },
        { ...base, name: 'cpu×4', cpu: 4 },
        { ...base, name: 'reduced motion', cpu: 1, reducedMotion: true },
      ]
    : [{ ...base, name: v.cpu ? `cpu×${v.cpu}` : v['reduced-motion'] ? 'reduced motion' : 'normal', cpu: Number(v.cpu) || 1, reducedMotion: !!v['reduced-motion'] }];
  const runs = Math.max(1, Number(v.runs) || 1);
  const steps = stepsFor(url, v);

  const all = [];
  for (const cond of conditions) {
    for (let r = 1; r <= runs; r++) {
      let recs;
      try {
        recs = await runCondition(pw, url, steps, cond, v);
      } catch (e) {
        fail(`${cond.name}: ${e.message.split('\n')[0]}`);
      }
      for (const rec of recs) all.push({ condition: cond.name, run: r, ...rec });
    }
  }

  const multi = all.length > 1;
  for (const r of all) {
    if (multi) console.log(`\n── ${r.name} · ${r.condition}${runs > 1 ? ` · run ${r.run}/${runs}` : ''}`);
    console.log(r.report);
  }
  if (multi) {
    // Which findings appear under which conditions.
    const seen = new Map();
    for (const r of all)
      for (const f of r.result.findings || []) {
        const key = `${r.name}|${f.severity}|${f.element}|${f.type}`;
        if (!seen.has(key)) seen.set(key, { f, name: r.name, hits: new Map() });
        // Count runs, not findings: one run can report the same thing twice.
        const hits = seen.get(key).hits;
        if (!hits.has(r.condition)) hits.set(r.condition, new Set());
        hits.get(r.condition).add(r.run);
      }
    if (seen.size) {
      console.log('\n── summary');
      for (const { f, name, hits } of [...seen.values()].sort((a, b) => SEV[b.f.severity] - SEV[a.f.severity])) {
        const where = conditions.map((c) => `${c.name} ${hits.has(c.name) ? hits.get(c.name).size : 0}/${runs}`).join(', ');
        console.log(`${f.severity.toUpperCase().padEnd(6)} ${name}: ${f.element} — ${f.message} (${where})`);
      }
    }
  }
  if (v.json) writeFileSync(v.json, JSON.stringify(all.map(({ report, ...rest }) => rest), null, 2));

  const failedExpect = all.some((r) => (r.result.expectations || []).some((e) => !e.pass));
  const floor = SEV[v['fail-on']] || Infinity;
  // Unanimated changes (pop-ins, swaps) can be intended; check those with expectations instead.
  const tooBad = all.some((r) => (r.result.findings || []).some((f) => f.group !== 'unanimated' && SEV[f.severity] >= floor));
  const hidden = all.some((r) => r.result.status === 'hidden' || r.result.status === 'error');
  process.exitCode = hidden ? 2 : failedExpect || tooBad ? 1 : 0;
}

main().catch((e) => {
  console.error(`antijank: ${e instanceof SetupError ? e.message : e.stack || e}`);
  process.exitCode = 2;
});
