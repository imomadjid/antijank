---
name: antijank
description: Headless animation and transition review. Records how elements move and fade frame by frame in a real browser and reports jank as text, with no screenshots - one-frame jumps, flashes at the wrong position, pop-ins without a fade, neighbours pushed in one frame, reversals, late corrections, flicker, scroll jumps, stretched text, slow frames. Use it after any change to animation, transitions, layout or anything that appears, disappears or moves (FLIP, layout and shared-element animations, accordions, toasts, modals, lists, chat messages, page loads), when the user reports something "jumps", "flashes", "flickers", "snaps", "shifts" or "feels janky", and to confirm a motion fix actually worked before calling it done.
---

# antijank

Measure motion instead of looking at it. A probe runs in the page, reads every watched element's box, effective opacity and scroll position after each painted frame, and reports only what looks wrong. You get a few lines of text per interaction, not frames to inspect.

It reports facts ("moved down 44px in one frame"), not taste. Judging whether a duration or easing feels right is a separate review.

## Pick how to run it

**A. The runner** (needs a shell, Node 20+ and Playwright in the project). Best default: headless, repeatable, can slow the CPU and emulate reduced motion.

```bash
node <skill-dir>/scripts/run.mjs http://localhost:3000/inbox --click "button[aria-label='Compose']" --root main
node <skill-dir>/scripts/run.mjs http://localhost:3000 --steps steps.json --matrix
node <skill-dir>/scripts/run.mjs http://localhost:3000/settings            # records the page load
```

`<skill-dir>` is this skill's folder (where this file is). If the project has no Playwright, the runner says so; install it with the project's package manager and run `npx playwright install chromium`. Run `node <skill-dir>/scripts/run.mjs --help` for every option.

**B. A browser you already drive** (Playwright MCP, Chrome DevTools MCP, any tool that runs JavaScript in the page). Load the probe, then record around the action:

- With Playwright's `page` object: `await page.addScriptTag({ path: '<skill-dir>/scripts/probe.js' })`. Use `page.addInitScript({ path })` instead to record a page load.
- With only "evaluate JavaScript": evaluate the contents of `scripts/probe.js` once per page (it is safe to load twice).

```js
const result = await antijank.record(() => document.querySelector('#open').click(), { root: 'main' });
antijank.report(); // the text report
```

For actions you trigger from outside the page (a real click through your tool), call `antijank.start(opts)`, do the action, then `await` the promise `start` returned, or `antijank.stop()` to end early.

## Workflow

1. **Decide what to record.** One interaction per recording: the trigger, the part of the page that should react (`root`), and what "done" means. If the change waits on the network, pass `waitFor` with a selector that exists once it has arrived, or recording may settle before anything happens.
2. **Use a production build when you can.** Dev builds replay effects (React StrictMode) and hot reload adds stalls, so motion can differ from what ships. If you must use dev, say so when you report.
3. **Record and read the report.** Severity is a starting point: HIGH is almost always visible, LOW is often fine.
4. **Write expectations for what should happen** (below) and rerun with them. This turns "looks fine" into pass/fail, and the same spec can guard against regressions later.
5. **Fix the cause, then rerun.** Use `--matrix` for the final check. It runs at normal speed, with the CPU slowed 4× and with reduced motion, because timing bugs (a slow first frame eating an animation, a late transform) often appear only when the CPU is slow.
6. **Report with numbers**, for example "composer moves 245 → 562px over 170ms, nothing else moves more than 1px, 0 findings in all three conditions".

## Findings and their usual causes

| Finding | Means | Usual cause and fix |
| --- | --- | --- |
| `blip` | Sat at a wrong position for 1–3 frames, then snapped back | FLIP transform applied a frame late (after paint). Measure and set the inverse transform in the same frame as the layout change: layout effect, not effect or rAF |
| `jump` (start) | Big first step, then a smooth move | Animation starts from the wrong origin, or the first frame paints before the start value is set |
| `jump` (end) / snap | Smooth move, then a snap at the end | Wrong target (stale measurement), or the transform is cleared before the layout matches |
| `jump` (mid) | One frame far bigger than its neighbours | Layout changed mid-animation (content arrived), or two animations handing over |
| `shift` | A resting element moved in one frame | Something above it was inserted, removed or resized with no animation. The cause names it. Animate the size, reserve space, or overlay instead |
| `pop-in` / `pop-out` | Appeared or vanished at full opacity | No enter or exit animation, or the enter transition never ran because the starting style was never rendered (class removed in the same frame it was added) |
| `flash` | Visible for only 1–2 frames | A placeholder or stale state rendering for a frame; conditional rendering flip-flopping |
| `flicker` | Opacity dipped and came back | Remount (key change), a state reset, or an exit animation restarting |
| `swap` | One element replaced by another in place, no crossfade | Shared-element or hero transition missing |
| `reversal` | Turned back partway through a move | Two animations driving one value, or a retarget toward an old position |
| `oscillation` | Direction flips frame to frame | Two scripts fighting (scroll anchoring against a follow, a ResizeObserver loop) |
| `resettle` | Moved again after resting | Correction after a late measurement (fonts, images, async content) |
| `overshoot` | Went well past its target | Spring bounce higher than intended. Ignore it if the bounce is deliberate |
| `stretch` | Text scaled unevenly | Scale animation on a box with text; counter-scale its children or animate size |
| `scroll-jump` / `scroll-fight` | Scroll position jumped or changed direction | Programmatic scroll without smoothing, scroll anchoring, or two followers |
| `slow-frame` | A frame took 50ms or more | Main-thread work during the animation (the script is named) |
| `layout-anim` | Animates width, height, top, margin and similar | Runs layout every frame. Fine for small accordions; prefer transforms for big or frequent motion |

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

- `moves`: net displacement from first to last frame, in px.
- `still`: elements that must not move more than `maxShift`. Use `"others"` for everything present the whole time and not named elsewhere.
- `fadesIn` and `fadesOut`: the element must start or end below 50% opacity.
- `noFindings`: no finding at or above that severity.

## Keeping the report useful

- Scope with `root` to the region that should react. It's faster and quieter. Portals added to `<body>` (dialogs, popovers) are still watched.
- Only elements that draw something (text, background, border, shadow, images, inputs) can produce findings. Transparent wrappers stay silent, so their painted children report instead.
- Infinite animations (spinners, shimmer) are ignored automatically. Mark anything else with `data-antijank-ignore`.
- Streaming text grows continuously, so expect `shift` findings caused by "grew taller (text changed)". Judge whether that growth should be smoothed.
- The header line shows the probe's cost per frame. If it is above about 4ms, narrow `root`.
- Thresholds can be overridden: `{ thresholds: { shift: 4, popArea: 1000 } }` (see `antijank.thresholds`).

## What it can't see

- Pixels inside `<canvas>` or WebGL, and paint-only changes (a colour flash with no box or opacity change).
- Clipping by `clip-path` or masks, and elements covered by others. Clipping by overflow is taken into account.
- Hidden tabs: browsers pause frames there, so the probe refuses to record (`status: hidden`). Bring the tab or pane to the front.
- Headless timing is close to real but not identical. Treat 1–2 frame differences as approximate.
- Virtualized lists recycle nodes, so a recycled row can look like a jump. Scope `root` away from them, or ignore them.
- Layout-shift entries from the browser ignore transforms. The probe does not rely on them: it reads boxes directly, so FLIP, layout and shared-element animations are covered.

## Inspecting one element

`antijank.timeline('[data-composer]')` returns that element's per-frame `{ t, x, y, w, h, opacity, visibleArea }` from the last recording. Use it when a finding needs a closer look, or to quote exact numbers.

## Signing in

The runner can reuse a saved Playwright session: `--storage-state auth.json`. The user can create one with `npx playwright codegen --save-storage=auth.json <url>`, signing in themselves. Never type the user's real credentials yourself.
