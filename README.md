# antijank

Headless animation review for coding agents. antijank records how elements move and fade, frame by frame, in a real browser. It then reports jank as a few lines of text: one-frame jumps, flashes at the wrong position, pop-ins with no fade, neighbours pushed in a single frame, reversals, late corrections, flicker, scroll jumps and stretched text.

There are no screenshots or videos to look at. An agent can check its own animation work, and a human gets numbers instead of "looks fine to me".

```
antijank 0.1.0 · settled after 347ms · 23 frames · 7 elements · probe 0.19ms/frame
HIGH   +10ms    div#card — was 320px down of its place for 1 frame, then snapped back [cause: div#card moved to a new parent]
HIGH   +14ms    div.row "a" ×4 — moved down 44px in one frame, with no transition [cause: div#banner inserted (1248×40)]
MEDIUM +14ms    div#banner — appeared at full opacity with no fade (1248×40)
expect ✗ still others: 4 moved more than 1px: div.row "a" 44px; div.row "b" 44px; div.row "c" 44px
```

## Install

As an agent skill (Claude Code, Codex, Cursor and [other agents](https://skills.sh)):

```bash
npx skills add MassiveMassimo/antijank
```

As a Claude Code plugin:

```text
/plugin marketplace add MassiveMassimo/antijank
/plugin install antijank@antijank
```

Then ask your agent to check an animation, or say what feels off ("the card flashes when it opens"). The skill tells the agent how to record it, read the report, fix the cause and confirm the fix.

## Use it yourself

The runner needs Node 20+ and Playwright in your project (`npm i -D playwright && npx playwright install chromium`).

```bash
# record what a click does, watching only <main>
node path/to/antijank/skills/antijank/scripts/run.mjs http://localhost:3000 --click "#compose" --root main

# record a page load
node .../run.mjs http://localhost:3000/settings

# scripted steps, run normally, with the CPU slowed 4× and with reduced motion
node .../run.mjs http://localhost:3000 --steps steps.json --matrix

# fail CI if anything moves that shouldn't
node .../run.mjs http://localhost:3000 --click "#compose" --expect '{"still":"others","fadesIn":["[role=dialog]"]}'
```

Or load `skills/antijank/scripts/probe.js` into any page you already drive, such as Playwright, Puppeteer, a DevTools console or a browser MCP:

```js
await antijank.record(() => document.querySelector('#compose').click(), { root: 'main' });
console.log(antijank.report());
antijank.timeline('[role=dialog]'); // per-frame x, y, w, h, opacity for one element

// Steps driven from outside the page: hold the recording open, then release it.
antijank.start({ root: 'main', hold: true });
// ...click, type, wait...
await antijank.release();
```

## What it reports

| Finding | What happened |
| --- | --- |
| `blip` | An element sat at a wrong position for 1–3 frames, then snapped back (the classic late FLIP) |
| `jump` | A move with one frame far bigger than its neighbours: at the start, in the middle, or as a snap at the end |
| `shift` | A resting element moved in a single frame, with the cause named (what was inserted, removed or resized) |
| `pop-in` / `pop-out` | Appeared or vanished at full opacity, including enter transitions that never ran |
| `flash` / `flicker` | Visible for only a frame or two, or opacity dipped and came back |
| `swap` | One element replaced another in place with no crossfade (a missing hero transition) |
| `reversal` / `oscillation` | Turned back mid-move, or flipped direction frame to frame (two things fighting) |
| `resettle` / `overshoot` | Moved again after resting, or went well past its target |
| `stretch` | Text scaled unevenly during a scale animation |
| `scroll-jump` / `scroll-fight` | Scroll position jumped, or kept changing direction |
| `slow-frame` | A frame took 50ms or more, with the script responsible |
| `layout-anim` | An animation drives width, height, top, margin and similar, so layout runs every frame |

Expectations turn a recording into a test: `moves`, `still`, `fadesIn`, `fadesOut`, `noFindings`. See [SKILL.md](skills/antijank/SKILL.md).

## How it works

- After each painted frame (a task posted from `requestAnimationFrame` runs once rendering is done), the probe reads every watched element's box, its effective opacity (multiplied through its ancestors), its visible area after overflow clipping, and the scroll positions.
- Positions are compared in both viewport and scroll-content coordinates, and each element is judged in whichever one it moved less, so scrolling isn't mistaken for movement and fixed elements aren't either.
- Only changes are stored. Detectors run once, at the end.
- A mutation observer names causes: inserted, removed, moved and resized elements.
- The Layout Instability and Long Animation Frame APIs add layout-shift entries and slow-frame attribution.
- Only elements that draw something can produce findings, and nested elements reporting the same thing collapse into the outermost one. Infinite animations, JavaScript loops that never stop, and `[data-antijank-ignore]` are left out.
- Overflow clipping follows containing blocks, so an absolute popover inside an `overflow: hidden` wrapper counts as visible when it is.
- Jumps are judged per unit of time, so a dropped frame isn't mistaken for one.

The probe reports its own cost per frame in the header line. It grows with the number of watched elements: about 4ms per frame for 1,500 elements on a fast laptop, far less with a scoped `root`. Reading layout after every frame can disturb a page that is already near its frame budget, so keep `root` narrow.

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
pnpm test            # every fixture in fixtures/ plus the runner
FIXTURE=flip pnpm test
```

Each page in `fixtures/` either plants one kind of jank, which must be found, or is a clean control, which must stay silent. New detectors come with a planted fixture and a clean one.

## Related

[dejitter](https://github.com/wende/dejitter) records rAF frames in the page and flags jitter, flicker and jumps along the same lines. antijank adds paint-aware filtering, cause attribution, expectations, a headless runner with CPU and reduced-motion conditions, and fixtures that test every detector.

## License

MIT
