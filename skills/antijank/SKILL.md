---
name: antijank
description: Catches one-frame UI glitches that screenshots miss. Records every element's position and opacity on every frame of an interaction in a real browser and reports, as a few lines of text, what jumped, flashed, popped in without a fade, pushed its neighbours, reversed, flickered, scrolled abruptly or responded slowly to a click. Runs in the browser you already drive (Chrome DevTools MCP, Playwright MCP) with nothing to install, or headless through its runner. Use it when the user reports that something "jumps", "flashes", "flickers", "snaps", "shifts" or "feels janky"; after writing or changing an animation or transition (FLIP, layout or shared-element animations, accordions, toasts, modals, list inserts, chat messages); and to confirm a motion fix worked before calling it done.
---

# antijank

Measure motion instead of looking at it. A probe runs in the page, reads every watched element's box, effective opacity and scroll position after each painted frame, and reports only what looks wrong. You get a few lines of text per interaction, not frames to inspect.

It reports facts ("moved down 44px in one frame"), not taste. Judging whether a duration or easing feels right is a separate review. Defects (blips, jumps, flicker, pushed neighbours) come first; changes that simply have no transition (pop-ins, swaps) are listed apart, because instant is often the right choice.

## Pick how to run it

`<skill-dir>` below is this skill's folder (where this file is).

**A. The browser you already drive: nothing to install.** If you have a browser tool (Chrome DevTools MCP, Playwright MCP, or a browser pane or extension that runs JavaScript), load the probe into the page you're testing. It keeps that browser's sign-in and adds nothing to the project.

| Your tool | Load the probe |
| --- | --- |
| Chrome DevTools MCP | `evaluate_script` with `sourcePath: "<skill-dir>/scripts/probe.js"` and `format: "script"` |
| Playwright MCP | `browser_run_code` (`browser_run_code_unsafe` in some versions): `async (page) => { await page.addScriptTag({ path: '<skill-dir>/scripts/probe.js' }) }` |
| A Playwright `page` in your own script | `await page.addScriptTag({ path: '<skill-dir>/scripts/probe.js' })` |
| A tool that only evaluates JavaScript text | Evaluate the CDN loader below. If it's blocked, evaluate the contents of `scripts/probe.min.js` (42KB) instead |

The CDN loader fetches this exact version, and the integrity hash makes the browser reject any other file:

```js
await new Promise((ok, fail) => {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/antijank@0.2.0/skills/antijank/scripts/probe.min.js';
  s.integrity = 'sha384-gbt1FS2nRYbhwU3zqdkxuKbH6++BQeLIjkpVPLNNOwbu361o2lV0U6li+N879FDf';
  s.crossOrigin = 'anonymous';
  s.onload = ok;
  s.onerror = () => fail(new Error('antijank: CDN script blocked (Content-Security-Policy or offline)'));
  document.head.append(s);
});
```

- Loading is safe to repeat on the same page, and needed again after every navigation.
- A strict Content-Security-Policy blocks script tags, so the CDN loader and `addScriptTag` fail on such pages. Evaluating the file's contents through DevTools (`evaluate_script` with `sourcePath`, or pasting `probe.min.js`) is not blocked.
- The tab has to be visible. Browsers pause frames in hidden tabs and panes, and the probe then refuses to record (`status: hidden`).
- Slow the CPU and turn on reduced motion with the same tool. In DevTools MCP, call `emulate` with `cpuThrottlingRate: 4`, then with `prefersReducedMotion: "reduce"`; each call replaces the last, and an empty call resets. In Playwright MCP, use `browser_emulate_media` with `reducedMotion: "reduce"`, and for the CPU run `const s = await page.context().newCDPSession(page); await s.send('Emulation.setCPUThrottlingRate', { rate: 4 })`.
- To record a page load, the probe has to run before the page's own scripts. With Playwright, add two init scripts, then load the page and wait for the result:
  ```js
  await page.addInitScript({ path: '<skill-dir>/scripts/probe.js' });
  await page.addInitScript(() => antijank.start({ root: 'main' }));
  await page.goto(url);
  const result = await page.evaluate(() => antijank.wait());
  ```
  Other tools: use the runner (B), which records the load by default.

**B. The runner: for CI, page loads and the whole matrix in one command.** It needs a shell, Node 22+ and Playwright in the project, and runs headless with its own Chromium, so it's repeatable.

```bash
node <skill-dir>/scripts/run.mjs http://localhost:3000/inbox --click "button[aria-label='Compose']" --root main
node <skill-dir>/scripts/run.mjs http://localhost:3000 --steps steps.json --matrix
node <skill-dir>/scripts/run.mjs http://localhost:3000/settings            # records the page load
```

The runner is Chromium-only and runs on Node, whatever the project uses. If the project has no Playwright, the runner says so. Add it with the package manager the project already uses (look at the lockfile), then download Chromium:

| Lockfile | Add Playwright | Download Chromium |
| --- | --- | --- |
| `pnpm-lock.yaml` | `pnpm add -D playwright` | `pnpm exec playwright install chromium` |
| `yarn.lock` | `yarn add -D playwright` | `yarn playwright install chromium` |
| `bun.lock` / `bun.lockb` | `bun add -d playwright` | `bunx playwright install chromium` |
| `deno.lock` | `deno add npm:playwright` (with `"nodeModulesDir": "auto"` in `deno.json`, so Node can find it) | `deno run -A npm:playwright install chromium` |
| `package-lock.json` or none | `npm i -D playwright` | `npx playwright install chromium` |

Ask before adding a dependency to someone else's project; option A needs none. Run `node <skill-dir>/scripts/run.mjs --help` for every option. The runner turns Content-Security-Policy off for its own browser.

## Recording

When the action can run inside the page:

```js
const result = await antijank.record(() => document.querySelector('#open').click(), { root: 'main' });
antijank.report(); // the text report
```

`record` waits for the action's promise before it lets the recording settle, so an async action with several steps is recorded whole.

When you drive the action from outside the page (real clicks and typing through your tool), hold the recording open until you are done:

```js
antijank.start({ root: 'main', hold: true }); // 1. evaluate
// 2. click, type, wait: as many steps as the interaction needs
await antijank.release(); // 3. evaluate: settles after the last step, resolves with the result
antijank.report();
```

Hover an element before clicking it (DevTools MCP `hover`, Playwright MCP `browser_hover`), as a person does, and start the recording a second or more before the first input. A click that jumps straight onto an element starts its hover effects with the press, and something that updates on its own (a clock, a live counter) needs that second to be recognised as already changing; either can otherwise be taken for the click's response. The runner hovers before every click.

Without `hold`, the recording settles as soon as nothing has moved for about 330ms, which can fall between two of your steps. A hold that is never released ends with an error after `holdTimeout` (60s by default). `antijank.wait()` resolves with the result once the recording ends; `antijank.stop()` ends it at once.

## Workflow

1. **Decide what to record.** One interaction per recording: the trigger, the part of the page that should react (`root`), and what "done" means. If the change waits on the network, pass `waitFor` with a selector that exists once it has arrived, or recording may settle before anything happens.
2. **Use a production build when you can.** Dev builds replay effects (React StrictMode) and hot reload adds stalls, so motion can differ from what ships. If you must use dev, say so when you report.
3. **Record and read the report.** Severity is a starting point: HIGH is almost always visible, LOW is often fine.
4. **Decide which findings are intended.** Unanimated changes are listed apart from defects. Instant is a valid choice for tabs, menus, tooltips and anything frequent or keyboard-driven, so don't add animation just to clear a finding. Pin the intended behaviour with an expectation, or mark the element `data-antijank-ignore`.
5. **Write expectations for what should happen** (below) and rerun with them. This turns "looks fine" into pass/fail, and the same spec can guard against regressions later.
6. **Fix the defects, then rerun.** For the final check, record at normal speed, with the CPU slowed 4× and with reduced motion (`--matrix` in the runner, or the emulation calls in A), because timing bugs (a slow first frame eating an animation, a late transform) often appear only when the CPU is slow.
7. **Report with numbers**, for example "composer moves 245 → 562px over 170ms, nothing else moves more than 1px, 0 findings in all three conditions".

## Findings and their usual causes

| Finding | Means | Usual cause and fix |
| --- | --- | --- |
| `blip` | Sat at a wrong position for 1–3 frames, then snapped back | FLIP transform applied a frame late (after paint). Measure and set the inverse transform in the same frame as the layout change: layout effect, not effect or rAF |
| `jump` (start) | Big first step, then a smooth move | Animation starts from the wrong origin, or the first frame paints before the start value is set |
| `jump` (end) / snap | Smooth move, then a snap at the end | Wrong target (stale measurement), or the transform is cleared before the layout matches |
| `jump` (mid) | One frame far bigger than its neighbours | Layout changed mid-animation (content arrived), or two animations handing over |
| `shift` | A resting element moved in one frame | Something above it was inserted, removed or resized with no animation. `[cause: …]` names an insertion, removal or move; `[same frame: …]` names a resize in the same frame, a likely cause rather than a proven one. Animate the size, reserve space, or overlay instead |
| `pop-in` / `pop-out` | Appeared or vanished at full opacity (unanimated) | Fine if instant is intended. Otherwise there is no enter or exit animation, or the enter transition never ran because the starting style was never rendered (class removed in the same frame it was added) |
| `flash` | Visible for only 1–2 frames | A placeholder or stale state rendering for a frame; conditional rendering flip-flopping |
| `flicker` | Opacity dipped and came back | Remount (key change), a state reset, or an exit animation restarting |
| `swap` | One element replaced by another in place, no crossfade (unanimated) | Fine for tabs and instant views. Otherwise a shared-element or hero transition is missing |
| `reversal` | Turned back partway through a move | Two animations driving one value, or a retarget toward an old position |
| `oscillation` | Direction flips frame to frame | Two scripts fighting (scroll anchoring against a follow, a ResizeObserver loop) |
| `resettle` | Moved again after resting | Correction after a late measurement (fonts, images, async content) |
| `overshoot` | Went well past its target | Spring bounce higher than intended. Ignore it if the bounce is deliberate |
| `stretch` | Text scaled unevenly | Scale animation on a box with text; counter-scale its children or animate size |
| `scroll-jump` / `scroll-fight` | Scroll position jumped or changed direction | Programmatic scroll without smoothing, scroll anchoring, or two followers |
| `slow-frame` | A frame took 50ms or more | Main-thread work during the animation (the script is named). "Forced layout" means a script read layout (`offsetHeight`, `getBoundingClientRect`) right after changing styles, usually in a loop: read everything first, then write |
| `slow-response` | A click, Enter, Space or Escape showed nothing for 100ms or more | No pressed or pending state while work or a request runs. Show one at once. `[cause: main thread busy …]` means a slow handler kept the response from painting |
| `layout-anim` | Animates width, height, top, margin and similar | Runs layout every frame. Fine for small accordions; prefer transforms for big or frequent motion |

Motion findings name the animation that was moving the element, or an ancestor, at that frame: `[animation: transition transform 300ms ease-out]`, `[animation: animation slide-in 400ms ease on div.panel]` or `[animation: Web Animation of opacity, transform 200ms linear]`. Go to that rule or call first. No animation named usually means the motion is driven by script (requestAnimationFrame, a spring library) or isn't animated at all.

## Expectations

Pass `expect` (option or `--expect`) to get pass/fail lines and exit code 1 on failure:

```json
{
  "moves": { "[data-composer]": { "dy": 317, "tolerance": 2 } },
  "still": "others",
  "maxShift": 1,
  "fadesIn": [".toast"],
  "fadesOut": ["[role=dialog]"],
  "noFindings": "medium"
}
```

- `moves`: net displacement from first to last frame, in px. If the element is remounted, it follows whichever copy is on screen.
- `still`: elements that must not move more than `maxShift`. Use `"others"` for everything present the whole time and not named elsewhere. A selector that matches nothing fails.
- `fadesIn`: the element must be below 50% opacity on its first visible frame and at 90% or more at the end. `fadesOut`: below 50% on its last visible frame.
- `noFindings`: no finding at or above that severity, unanimated ones included.
- The runner's `--fail-on <severity>` exits 1 on defects at or above that severity. Unanimated changes don't count there; require a fade with `fadesIn` or `fadesOut` instead.
- Any selector that matches nothing fails its expectation, so a typo can't pass silently.

## Keeping the report useful

- Scope with `root` to the region that should react. It's faster and quieter. Overlays added outside it are still watched: anything added straight to `<body>`, fixed-position elements, and dialogs, menus, popovers, tooltips and toasts (found by `role`, `aria-modal`, `popover` or `<dialog>`).
- A `root` that doesn't exist yet is waited for. Whatever it holds when it appears is the baseline, so to judge how a panel appears, use a root that exists before it (or none).
- A subtree inserted at once (or moved into place, as streamed HTML is) is reported as one finding naming the subtree and how many elements it holds.
- Only elements that draw something (text, background, border, shadow, backdrop filter, `::before`/`::after` content, images, form controls) can produce findings. Transparent wrappers stay silent, so their painted children report instead.
- Infinite CSS and Web Animations (spinners, shimmer) are ignored automatically. A JavaScript loop that never stops (a ticker) makes the recording time out; elements whose own position or opacity changed in most frames (for at least 60 frames) are then left out and listed as loops. Their parents and children are still judged on their own. Mark anything else with `data-antijank-ignore`.
- At most 1500 elements are watched from the start, plus 1000 added during the recording. Past that the report warns that findings may be missing; narrow `root`.
- A recording settles about 330ms after the last change, so a response slower than that falls outside it and isn't measured. For slow actions (network, heavy work), add a `wait` step after the click or pass `waitFor` with a selector for the result.
- Streaming text grows continuously, so expect `shift` findings caused by "grew taller (text changed)". Judge whether that growth should be smoothed.
- The header line shows the probe's cost per frame: roughly 4–8ms per 1000 elements on a fast laptop, more with the CPU slowed. Reading layout after every frame can disturb a page that is already near its frame budget, so if the cost is above about 4ms, narrow `root`.
- Thresholds can be overridden: `{ thresholds: { shift: 4, popArea: 1000 } }` (see `antijank.thresholds`).

## What it can't see

- Pixels inside `<canvas>` or WebGL, and paint-only changes (a colour flash with no box or opacity change). For the same reason, a control whose only feedback is a colour change can get a `slow-response` it doesn't deserve: check whether it changes colour on press.
- Clipping by `clip-path` or masks, and elements covered by others. Clipping by overflow is taken into account, including absolute and fixed elements that escape it because their containing block is further out.
- Inside shadow DOM and iframes: the shadow host and the `<iframe>` box are watched, not their contents. Load the probe inside the frame to record it.
- Shapes inside an `<svg>`: only the `<svg>` box is watched.
- Hidden tabs: browsers pause frames there, so the probe refuses to record (`status: hidden`). Bring the tab or pane to the front.
- Headless timing is close to real but not identical. Treat 1–2 frame differences as approximate.
- What the compositor shows during a main-thread stall. CSS and Web Animations of transform and opacity keep moving on screen while the main thread is busy; the probe only sees where they got to. Jumps right after a slow frame on such elements are left out, and the slow frame is reported.
- View Transitions: the morph runs in `::view-transition` pseudo-elements. The report says when one ran and leaves out element findings from that window. Judge the transition itself another way.
- Browsers other than Chromium: Safari- or Firefox-only jank is out of reach.
- Virtualized lists recycle nodes, so a recycled row can look like a jump. Scope `root` away from them, or ignore them.
- Layout-shift entries from the browser ignore transforms. The probe does not rely on them: it reads boxes directly, so FLIP and layout animations are covered. The entries are kept in the JSON result (`layoutShifts`) for reference.

## Inspecting one element

`antijank.timeline('[data-composer]')` returns that element's per-frame `{ t, x, y, w, h, opacity, visibleArea }` from the last recording. Use it when a finding needs a closer look, or to quote exact numbers.

## Signing in

The runner can reuse a saved Playwright session: `--storage-state auth.json`. The user can create one with `npx playwright codegen --save-storage=auth.json <url>`, signing in themselves. Never type the user's real credentials yourself.
