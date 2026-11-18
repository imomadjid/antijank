# antijank

[![test](https://github.com/MassiveMassimo/antijank/actions/workflows/test.yml/badge.svg)](https://github.com/MassiveMassimo/antijank/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/hero-dark.svg">
  <img alt="Seven frames of a card sliding down. In frame 4 it sits 38px below where it should be, then snaps back. antijank reports it as a HIGH blip, and both expectations pass." src="assets/hero-light.svg" width="100%">
</picture>

Headless animation review for coding agents. antijank records every frame of an interaction in a real browser and tells your agent, in a few lines of text, what jumped, flashed, popped in or pushed its neighbours. It works with Claude Code, Codex, Cursor and [other agents](https://skills.sh) that run skills.

## Why

Agents check UI with screenshots, and jank lives between them. A card that sits in the wrong place for one frame, a banner that shoves the list down 44px, a dialog whose fade never ran: each lasts 16ms and is gone before the next screenshot. A video would catch it, but an agent can't watch one well, and you'd still have to say "looks fine to me".

antijank measures instead of looking. A small probe reads every element's box, opacity and scroll position after each painted frame, then reports only what looks wrong, with the element, the frame and the cause. Your agent can check its own motion work, and you get numbers.

## Install

```bash
npx skills add MassiveMassimo/antijank
```

Or as a Claude Code plugin:

```text
/plugin marketplace add MassiveMassimo/antijank
/plugin install antijank@antijank
```

Recording needs Node 22+ and Playwright in the project you're testing. The skill tells your agent to add it if it's missing:

```bash
npm i -D playwright && npx playwright install chromium
```

## Use

Ask in your own words. The agent picks up the skill when motion is involved:

```text
check the compose dialog's open animation for jank
the card flashes when it opens, find out why
make sure nothing else moves when the first message is sent
record the settings page load on a slow CPU
```

The agent records the interaction, reads the report, fixes the cause and records again. Before it calls the work done, it reruns at normal speed, with the CPU slowed 4× and with reduced motion. A typical report:

```text
antijank 0.1.0 · settled after 360ms · 23 frames · 7 elements · probe 0.34ms/frame
HIGH   +26ms    div.row "a" ×4 — moved down 44px in one frame, with no transition [cause: div#banner inserted (1248×40)]
MEDIUM +26ms    div#banner — appeared at full opacity with no fade (1248×40)
expect ✗ still others: 4 moved more than 1px: div.row "a" 44px; div.row "b" 44px; div.row "c" 44px
```

## What it catches

| Finding | What happened |
| --- | --- |
| `blip` | Sat at a wrong position for 1–3 frames, then snapped back: a late FLIP, even mid-move |
| `jump` | One frame far bigger than its neighbours: at the start, in the middle, or as a snap at the end |
| `shift` | A resting element moved in a single frame, with the cause named (what was inserted, removed or resized) |
| `pop-in` / `pop-out` | Appeared or vanished at full opacity, including enter transitions that never ran |
| `flash` / `flicker` | Visible for only a frame or two, opacity dipped and came back, or a remount left a blank frame |
| `swap` | One element replaced another in place with no crossfade (a missing shared-element transition) |
| `reversal` / `oscillation` | Turned back mid-move, or flipped direction frame to frame (two things fighting) |
| `resettle` / `overshoot` | Moved again after resting, or went well past its target |
| `stretch` | Text scaled unevenly during a scale animation |
| `scroll-jump` / `scroll-fight` | Scroll position jumped, or kept changing direction |
| `slow-frame` | A frame took 50ms or more, with the script responsible |
| `layout-anim` | An animation drives width, height, top, margin and similar, so layout runs every frame |

Expectations turn a recording into a test: `moves`, `still`, `fadesIn`, `fadesOut` and `noFindings` pass or fail, and the runner exits 1 on a failure. See [SKILL.md](skills/antijank/SKILL.md).

## Run it yourself

The runner is a single script with no dependencies beyond the Playwright already in your project:

```bash
# record what a click does, watching only <main>
node skills/antijank/scripts/run.mjs http://localhost:3000 --click "#compose" --root main

# record a page load
node skills/antijank/scripts/run.mjs http://localhost:3000/settings

# scripted steps, at normal speed, with the CPU slowed 4× and with reduced motion
node skills/antijank/scripts/run.mjs http://localhost:3000 --steps steps.json --matrix

# fail CI if anything moves that shouldn't
node skills/antijank/scripts/run.mjs http://localhost:3000 --click "#compose" \
  --expect '{"still":"others","fadesIn":["[role=dialog]"]}'
```

Or load `skills/antijank/scripts/probe.js` into a page you already drive, such as Playwright, Puppeteer, a DevTools console or a browser MCP:

```js
await antijank.record(() => document.querySelector('#compose').click(), { root: 'main' });
console.log(antijank.report());
antijank.timeline('[role=dialog]'); // per-frame x, y, w, h and opacity for one element

// Steps driven from outside the page: hold the recording open, then release it.
antijank.start({ root: 'main', hold: true });
// ...click, type, wait...
await antijank.release();
```

## How it works

- **After every painted frame** (a task posted from `requestAnimationFrame` runs once rendering is done), the probe reads each watched element's box, its effective opacity through its ancestors, its visible area after overflow clipping, and the scroll positions. Only changes are stored, and the detectors run once, at the end.
- **Scrolling isn't movement.** Positions are kept in both viewport and scroll-content coordinates, and each element is judged in whichever one it moved less. Clipping follows containing blocks, so an absolute popover inside an `overflow: hidden` wrapper counts as visible when it is.
- **Causes are named.** A mutation observer records what was inserted, removed, moved or resized in the frame that pushed things.
- **Noise stays out.** Only elements that draw something can report. Nested elements reporting the same thing collapse into the outermost one, and a subtree inserted at once is one finding. Infinite animations, JavaScript loops and `[data-antijank-ignore]` are left out, and a dropped frame isn't mistaken for a jump.
- **The browser adds the rest.** Layout Instability and Long Animation Frame entries supply layout shifts and the script behind a slow frame.

The header line shows the probe's own cost per frame: about 4ms for 1,500 elements on a fast laptop, far less with a scoped `root`. Reading layout every frame can disturb a page that is already near its frame budget, so keep `root` narrow.

## What it can't see

- **Inside `<canvas>` and WebGL**, and paint-only changes such as a colour flash with no change in box or opacity.
- **`clip-path`, masks, and elements covered by others.** Clipping by overflow is taken into account.
- **Inside shadow DOM, iframes and `<svg>`.** The host, frame or `<svg>` box is watched, not what's inside it.
- **Pages with a strict Content-Security-Policy**, when you inject the probe yourself. The runner turns CSP off for its own browser.
- **Hidden tabs and panes.** Browsers pause frames there, so the probe refuses to record rather than return nothing.
- **Exact timing.** Headless timing is close to a real display but not identical.

The browser's own layout-shift entries ignore transforms. antijank doesn't depend on them: it reads boxes, so FLIP, layout and shared-element animations are covered.

## Develop

```bash
pnpm install
pnpm exec playwright install chromium
pnpm test              # every fixture in fixtures/ plus the runner
FIXTURE=flip pnpm test
```

Each page in `fixtures/` either plants one kind of jank, which must be found, or is a clean control, which must stay silent. New detectors come with a planted fixture and a clean one. The hero image is drawn from a real recording by `python3 assets/hero.py`.

## Related

[dejitter](https://github.com/wende/dejitter) records rAF frames in the page and flags jitter, flicker and jumps along the same lines. antijank adds paint-aware filtering, cause attribution, expectations, a headless runner with CPU and reduced-motion conditions, and fixtures that test every detector.

## License

[MIT](LICENSE)
