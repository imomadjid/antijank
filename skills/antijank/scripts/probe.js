/*! antijank probe | MIT | https://github.com/imomadjid/antijank */
// Records how elements move and fade, frame by frame, and reports only what looks wrong:
// one-frame jumps, flashes, pop-ins, reversals, pushed neighbours, late settles, scroll jumps.
// No screenshots: everything comes from the DOM (boxes, effective opacity, scroll positions),
// read after each frame is painted. Load it into a page, then:
//   await antijank.record(() => button.click(), { root: 'main' })
//   antijank.report()
(() => {
  if (typeof window === 'undefined' || (window.antijank && window.antijank.version)) return;

  const VERSION = '0.2.1';

  const THRESHOLDS = {
    eps: 0.5, // px: movement below this is noise
    shift: 2, // px: a one-frame move of a resting element worth reporting
    bigShift: 8, // px: a one-frame move that is clearly visible
    jumpRatio: 4, // a frame moving this many times the run's median is a jump
    jumpMin: 6, // px: smallest jump worth reporting
    bigJump: 16,
    reversalBefore: 0.85, // turning back before this share of the move is a stutter
    overshoot: 0.25, // overshoot past the end allowed as a share of the move (springs)
    overshootMin: 4,
    restFrames: 6, // frames at rest before a new move counts as "moved again"
    popArea: 400, // px²: smallest visible area for pop-in / pop-out reports
    bigArea: 10000,
    flicker: 0.3, // opacity dip or spike that comes back
    blipFrames: 3, // "comes back" within this many frames
    scrollJump: 48,
    slowFrame: 50, // ms
    forcedLayout: 20, // ms of forced style and layout in a slow frame worth naming
    slowResponse: 100, // ms from an input to the first visible change
    stretch: 0.06, // scaleX/scaleY mismatch for text
  };

  const DEFAULTS = {
    root: null, // selector, element or array; default <body>
    portals: true, // also watch elements added straight to <body> (dialogs, popovers)
    // Scrollbar thumbs move whenever content grows; they are chrome, not content.
    ignore: '[data-antijank-ignore], [role="scrollbar"], [data-slot*="scroll-area-scrollbar"], [data-slot*="scroll-area-thumb"], [data-radix-scroll-area-thumb]',
    maxElements: 1500, // elements watched from the start
    maxAdded: 1000, // extra budget for elements added during the recording
    settleFrames: 20, // ~330ms at 60Hz: long enough to catch a late correction
    minDuration: 100,
    timeout: 5000,
    waitFor: null, // selector or function; settling only counts once it is true
    hold: false, // don't settle until antijank.release() (for actions driven from outside the page)
    holdTimeout: 60000,
    maxLines: 10,
    expect: null,
  };

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BR', 'WBR', 'HEAD', 'TITLE',
    'SOURCE', 'TRACK', 'PARAM', 'BASE', 'COL', 'COLGROUP', 'DATALIST', 'OPTION', 'OPTGROUP',
  ]);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const INPUTS = ['pointerdown', 'pointerup', 'keydown', 'click'];
  // Findings about how something moved, which a running animation may explain.
  const MOTION = new Set(['blip', 'jump', 'reversal', 'oscillation', 'overshoot', 'resettle', 'stretch', 'flash', 'flicker', 'opacity-snap']);
  // Which animated properties can explain a finding: opacity for fades, the rest for moves
  // and resizes (camelCase from keyframes, kebab-case from transitions).
  const FADES = new Set(['flash', 'flicker', 'opacity-snap']);
  const FADE_PROPS = /^(all|opacity)$/i;
  const MOVE_PROPS = /^(all|transform|translate|scale|rotate|offset|top|left|right|bottom|inset|width|height|min|max|margin|padding|flex|grid)/i;
  const SEV = { high: 3, medium: 2, low: 1 };
  // Changes with no transition. Reported apart from defects: instant is often right.
  const UNANIMATED = new Set(['pop-in', 'pop-out', 'swap', 'opacity-snap']);
  const LAYOUT_PROP =
    /^(width|height|top|left|right|bottom|inset|margin|padding|minWidth|minHeight|maxWidth|maxHeight|flexBasis|gridTemplate|fontSize|lineHeight|borderWidth)/;

  // Row layout: [frame, vx, vy, cx, cy, w, h, opacity, visibleArea, stretch, rendered]
  const F_ = 0, VX = 1, VY = 2, CX = 3, CY = 4, W = 5, H = 6, O = 7, A = 8, K = 9, R = 10;

  let current = null;
  let last = null;
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (el) => {
    let id = ids.get(el);
    if (!id) ids.set(el, (id = nextId++));
    return id;
  };
  const styles = new WeakMap();
  const styleOf = (el) => {
    let cs = styles.get(el);
    if (!cs) styles.set(el, (cs = getComputedStyle(el)));
    return cs;
  };

  // ---------- describing elements ----------

  const squash = (s, n) => {
    s = String(s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const ownText = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.data;
    return t.trim();
  };
  // Visible-ish text: skips <style>, <script> and the like (an <html> or <body> would
  // otherwise be named by its CSS).
  function textOf(el) {
    if (el.localName === 'html' || el.localName === 'head') return '';
    let t = '';
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && SKIP_TAGS.has(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n;
    while ((n = w.nextNode()) && t.length < 60) t += n.data;
    return t;
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return String(el);
    let s = el.tagName.toLowerCase();
    if (el.id && !/^[:«r]|\d{3,}/.test(el.id)) return s + '#' + el.id;
    let named = false;
    for (const a of ['data-testid', 'data-slot', 'aria-label', 'role', 'name']) {
      const v = el.getAttribute(a);
      if (v) {
        s += `[${a}="${squash(v, 24)}"]`;
        named = true;
        break;
      }
    }
    if (!named) {
      for (const a of el.attributes) {
        if (a.name.startsWith('data-') && !/^data-(state|side|align|orientation|headlessui|radix)/.test(a.name)) {
          s += a.value && a.value.length < 20 ? `[${a.name}="${a.value}"]` : `[${a.name}]`;
          named = true;
          break;
        }
      }
    }
    if (!named && typeof el.className === 'string') {
      const cls = el.className.split(/\s+/).filter((c) => c && !/[:[\]/!@%()]/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
    }
    const text = squash(textOf(el), 24);
    if (text) s += ` "${text}"`;
    return s;
  }
  const descOf = (tr) => tr.desc || (tr.desc = describe(tr.el));

  // Only elements that draw something can visibly jump or pop. Transparent wrappers are
  // left out, so their painted children report instead of every container around them.
  const REPLACED = /^(img|svg|video|canvas|input|textarea|select|button|iframe|hr|progress|meter|picture|object|embed)$/;
  // Only the alpha decides: rgb(255, 0, 0) is red, not transparent.
  const transparent = (c) => {
    if (!c || c === 'transparent') return true;
    const legacy = /^rgba\(([^)]*)\)$/.exec(c);
    if (legacy) return parseFloat(legacy[1].split(',')[3]) === 0;
    return /\/\s*0(\.0*)?%?\)$/.test(c);
  };
  function boxPaints(cs) {
    if (!transparent(cs.backgroundColor) || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none') return true;
    if (cs.backdropFilter && cs.backdropFilter !== 'none') return true;
    for (const side of ['Top', 'Right', 'Bottom', 'Left'])
      if (cs[`border${side}Style`] !== 'none' && parseFloat(cs[`border${side}Width`]) > 0 && !transparent(cs[`border${side}Color`])) return true;
    return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  }
  function paints(el, cs) {
    if (REPLACED.test(el.localName) || ownText(el) || boxPaints(cs)) return true;
    // Icons and decorations drawn by ::before / ::after.
    for (const p of ['::before', '::after']) {
      const ps = getComputedStyle(el, p);
      const c = ps.content;
      if (!c || c === 'none' || c === 'normal') continue;
      if (c !== '""' || boxPaints(ps)) return true;
    }
    return false;
  }

  // ---------- recording ----------

  function resolveRoots(r) {
    if (!r) return document.body ? [document.body] : [];
    const list = Array.isArray(r) ? r : [r];
    return list.flatMap((x) => (typeof x === 'string' ? [...document.querySelectorAll(x)] : [x])).filter(Boolean);
  }

  function env() {
    const mm = (q) => (typeof matchMedia === 'function' ? matchMedia(q).matches : false);
    return {
      url: location.href,
      viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
      reducedMotion: mm('(prefers-reduced-motion: reduce)'),
      visibility: document.visibilityState,
    };
  }

  const newPending = () => ({ added: [], removed: [], text: new Set() });

  function start(userOpts) {
    if (current) finish(current, 'restarted');
    const o = userOpts || {};
    const opts = { ...DEFAULTS, ...o, thresholds: { ...THRESHOLDS, ...(o.thresholds || {}) } };
    const rec = {
      opts,
      t0: performance.now(),
      frames: [],
      tracks: new Map(),
      trackOf: new WeakMap(),
      scrollers: new Map(),
      pending: newPending(),
      mutations: [],
      anims: new Map(),
      ignored: new Set(),
      vtFrames: new Set(),
      roots: null,
      extraRoots: [],
      layoutShifts: [],
      loafs: [],
      overhead: [],
      spans: [], // [start, end] of each of the probe's own callbacks, to keep them out of LoAF attribution
      sampledAt: [], // when each frame was sampled, ms after t0
      inputs: [],
      synthetic: false, // accept script-dispatched events (only while record()'s action runs)
      status: 'recording',
      quiet: 0,
      truncated: 0,
      nextTrack: 1,
      baseF: null,
      held: !!opts.hold,
      tGo: performance.now(), // when settling may start: t0, or the release of a hold
      env: env(),
      observers: [],
    };
    rec.done = new Promise((resolve) => (rec.resolve = resolve));
    if (document.visibilityState !== 'visible') {
      finish(rec, 'hidden');
      return rec.done;
    }
    current = rec;
    rec.mo = new MutationObserver((list) => onMutations(rec, list));
    rec.mo.observe(document.documentElement || document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    observe(rec, 'layout-shift', (e) =>
      rec.layoutShifts.push({
        t: e.startTime - rec.t0,
        value: e.value,
        hadRecentInput: e.hadRecentInput,
        sources: (e.sources || []).map((s) => ({
          element: s.node && s.node.nodeType === 1 ? describe(s.node) : s.node ? '#text' : null,
          dx: s.currentRect.x - s.previousRect.x,
          dy: s.currentRect.y - s.previousRect.y,
        })),
      })
    );
    observe(rec, 'long-animation-frame', (e) =>
      rec.loafs.push({
        t: e.startTime - rec.t0,
        duration: e.duration,
        blocking: e.blockingDuration,
        // Every script, so the probe's own can be told apart later (analysis drops them).
        all: (e.scripts || []).map((s) => {
          const file = (u) => (u || '').split('#')[0].split('?')[0].split('/').pop();
          const inv = s.invoker || '';
          return {
            start: s.startTime,
            duration: s.duration,
            forced: s.forcedStyleAndLayoutDuration || 0,
            // The invoker is a URL for top-level script runs; the file name says enough.
            name: s.sourceFunctionName || (/^[a-z]+:\/\//i.test(inv) ? '' : inv),
            source: file(s.sourceURL) || file(inv),
          };
        }),
      })
    );
    // Inputs, to time how long each one takes to show a response. A press runs from
    // pointerdown to its click (or pointerup), and the response is timed from its end, so
    // holding the button down isn't slowness. Typing is left out: a keystroke in a text
    // field changes its value, which the probe can't see. Events dispatched by the page's
    // own scripts count only while record()'s action runs (that is the interaction).
    rec.onInput = (e) => {
      if (!e.isTrusted && !rec.synthetic) return;
      const el = e.target && e.target.nodeType === 1 ? e.target : null;
      const target = el ? describe(el) : '';
      const t = e.timeStamp - rec.t0;
      const last = rec.inputs[rec.inputs.length - 1];
      if (e.type === 'pointerup' || e.type === 'click') {
        if (last && last.pointer && !last.ended && t - last.start < 10000) {
          last.end = t;
          last.ended = e.type === 'click';
          return;
        }
        // Enter or Space on a button fires a click after its keydown: one input.
        if (e.type === 'pointerup' || (last && last.key && t - last.start < 1000)) return;
        rec.inputs.push({ start: t, end: t, input: 'click', target, pointer: true, ended: true });
      } else if (e.type === 'pointerdown') {
        rec.inputs.push({ start: t, end: t, input: 'click', target, pointer: true });
      } else {
        if (e.repeat || !['Enter', 'Escape', ' '].includes(e.key)) return;
        const text = el && (el.isContentEditable || el.localName === 'textarea');
        const field = el && el.localName === 'input' && !/^(button|submit|reset|checkbox|radio|image|file|color|range)$/.test(el.type);
        if (text || (e.key === ' ' && field)) return;
        rec.inputs.push({ start: t, end: t, input: `${e.key === ' ' ? 'Space' : e.key} key`, target, key: true });
      }
    };
    for (const type of INPUTS) window.addEventListener(type, rec.onInput, { capture: true, passive: true });
    rec.onHide = () => document.visibilityState !== 'visible' && finish(rec, 'hidden');
    document.addEventListener('visibilitychange', rec.onHide);
    if (document.body) {
      setupRoots(rec, 0);
      if (rec.roots) onFrame(rec, rec.t0, true);
    }
    rec.channel = new MessageChannel();
    rec.channel.port1.onmessage = () => {
      const ts = rec.pendingTs;
      rec.pendingTs = null;
      if (ts != null) sampleFrame(rec, ts);
    };
    const tick = (ts) => {
      if (rec.status !== 'recording') return;
      // Sample after this frame paints: a task posted from rAF normally runs once rendering
      // is done. Right after real input, Chromium can render several frames back to back
      // before that task gets a turn. Then the last frame is still unsampled when the next
      // one starts, and nothing has run in between, so sample it here, before the page's
      // own callbacks for this frame change anything.
      if (rec.pendingTs != null) {
        const prev = rec.pendingTs;
        rec.pendingTs = null;
        sampleFrame(rec, prev);
        if (rec.status !== 'recording') return;
      }
      rec.pendingTs = ts;
      rec.channel.port2.postMessage(0);
      rec.raf = requestAnimationFrame(tick);
    };
    rec.raf = requestAnimationFrame(tick);
    armBackstop(rec);
    return rec.done;
  }

  // A last resort in case frames stop (the tab is throttled, the page is frozen).
  function armBackstop(rec) {
    clearTimeout(rec.backstop);
    const ms = rec.held ? rec.opts.holdTimeout : rec.opts.timeout + 1000;
    const why = `still held after ${rec.opts.holdTimeout}ms: the action never finished, or release() was never called (raise holdTimeout for longer actions)`;
    rec.backstop = setTimeout(() => finish(rec, rec.held ? 'error' : 'timeout', rec.held ? why : null), ms);
  }

  // The result of the recording in progress (or of the last one), once it ends.
  const wait = () => (current ? current.done : Promise.resolve(last && last.result));

  // End a hold: settling starts counting now, so the last action's effects are recorded.
  function release() {
    const rec = current;
    if (!rec) return Promise.resolve(last && last.result);
    if (rec.held) {
      rec.held = false;
      rec.quiet = 0;
      rec.tGo = performance.now();
      armBackstop(rec);
    }
    return rec.done;
  }

  function observe(rec, type, fn) {
    try {
      if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
      const handle = (entries) => {
        if (rec.status === 'recording') for (const e of entries) if (e.startTime >= rec.t0) fn(e);
      };
      const po = new PerformanceObserver((list) => handle(list.getEntries()));
      po.observe({ type, buffered: false });
      rec.observers.push({ po, handle });
    } catch (_) {
      /* unsupported */
    }
  }

  // A root that doesn't exist yet is waited for. Whatever it holds when it appears is the
  // baseline, so to judge how something appears, pick a root that exists before it does.
  function setupRoots(rec, f) {
    const roots = resolveRoots(rec.opts.root);
    if (!roots.length) return;
    rec.roots = roots;
    rec.baseF = f;
    for (const root of roots) collect(rec, root, f);
    rec.baseCount = rec.tracks.size;
  }

  function ignoredEl(rec, el) {
    const sel = rec.opts.ignore;
    if (sel && el.closest && el.closest(sel)) return true;
    for (const t of rec.ignored) if (t.contains(el)) return true;
    return false;
  }

  function collect(rec, root, f) {
    if (root.nodeType !== 1 || SKIP_TAGS.has(root.tagName) || ignoredEl(rec, root)) return;
    if (root.namespaceURI === SVG_NS && root.localName !== 'svg') return; // only the <svg> box
    const sel = rec.opts.ignore;
    addTrack(rec, root, f);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (SKIP_TAGS.has(n.tagName)) return NodeFilter.FILTER_REJECT;
        if (sel && n.matches(sel)) return NodeFilter.FILTER_REJECT;
        if (n.namespaceURI === SVG_NS && n.localName !== 'svg') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    // Over budget, keep walking only to count what was left out.
    while ((n = walker.nextNode())) addTrack(rec, n, f);
  }

  const liveTrack = (rec, el) => {
    const tr = rec.trackOf.get(el);
    return tr && tr.died === null ? tr : null;
  };

  function addTrack(rec, el, f) {
    if (liveTrack(rec, el)) return true;
    // Elements added later get their own budget, so a full page can't starve a new dialog.
    const cap = f === rec.baseF ? rec.opts.maxElements : rec.baseCount + rec.opts.maxAdded;
    if (rec.tracks.size >= cap) {
      rec.truncated++;
      return false;
    }
    // A node removed and put back later gets a new track: it's a new appearance.
    const tr = {
      id: rec.nextTrack++,
      el,
      parent: el.parentElement ? idOf(el.parentElement) : 0,
      born: f,
      died: null,
      rows: [],
      last: null,
      text: !!ownText(el),
      desc: null,
      skip: false,
    };
    for (const t of rec.ignored) if (t.contains(el)) tr.skip = true;
    rec.tracks.set(tr.id, tr);
    rec.trackOf.set(el, tr);
    return true;
  }

  function inRoots(rec, el) {
    for (const r of rec.roots) if (r.contains(el)) return true;
    return false;
  }

  // Overlays rendered outside the watched root: straight into <body>, or into a layer
  // container that already existed (dialogs, menus, popovers, toasts).
  const OVERLAY = 'dialog, [popover], [aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [role="status"], [role="alert"]';
  // Inside a wrapper, only modal-like overlays count: a status line deep in a re-rendered
  // sidebar shouldn't pull the whole sidebar in.
  const MODAL = 'dialog, [popover], [aria-modal="true"], [role="dialog"], [role="alertdialog"]';
  function isPortal(el) {
    if (el.parentElement === document.body) return true;
    try {
      if (el.matches(OVERLAY) || el.querySelector(MODAL)) return true;
    } catch (_) {
      /* old browser */
    }
    return styleOf(el).position === 'fixed';
  }

  function onMutations(rec, list) {
    if (rec.status !== 'recording') return;
    const p = rec.pending;
    for (const m of list) {
      if (m.type === 'characterData') {
        if (m.target.parentElement) p.text.add(m.target.parentElement);
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) p.added.push(n);
        else if (n.nodeType === 3 && m.target.nodeType === 1) p.text.add(m.target);
      }
      for (const n of m.removedNodes) if (n.nodeType === 1) p.removed.push(n);
    }
  }

  function takeMutations(rec, f) {
    const p = rec.pending;
    rec.pending = newPending();
    const added = [];
    if (rec.roots && rec.roots.length) {
      for (const el of p.added) {
        if (!el.isConnected || ignoredEl(rec, el)) continue;
        const inside = inRoots(rec, el);
        const portal = !inside && rec.opts.portals && isPortal(el);
        if (!inside && !portal) continue;
        if (portal) rec.roots.push(el);
        if (!liveTrack(rec, el)) added.push(el);
        collect(rec, el, f);
      }
    }
    const top = (els) => els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
    rec.mutations[f] = {
      added: top(added),
      // Removed and put back in the same frame: moved to a new place in the DOM.
      moved: top(p.removed.filter((el) => el.isConnected)),
      removed: top(p.removed.filter((el) => !el.isConnected)),
      text: [...p.text],
    };
  }

  // The probe's own callbacks show up in long-animation-frame entries; remember when they ran.
  function sampleFrame(rec, ts) {
    const s = performance.now();
    onFrame(rec, ts, false);
    rec.spans.push([s, performance.now()]);
  }

  function onFrame(rec, ts, baseline) {
    if (rec.status !== 'recording') return;
    if (!rec.roots) {
      if (document.body) setupRoots(rec, rec.frames.length);
      if (!rec.roots) {
        if (!rec.held && performance.now() - rec.tGo >= rec.opts.timeout) finish(rec, 'error', `root not found: ${rec.opts.root}`);
        return;
      }
    }
    const f = rec.frames.length;
    rec.frames.push(baseline ? 0 : Math.max(0, ts - rec.t0));
    rec.sampledAt.push(performance.now() - rec.t0);
    takeMutations(rec, f);
    const running = scanAnimations(rec, f);
    const changed = sample(rec, f);
    if (baseline) return;
    rec.quiet = changed || running ? 0 : rec.quiet + 1;
    if (rec.held) return;
    const elapsed = performance.now() - rec.tGo;
    const w = rec.opts.waitFor;
    const ready = !w || (typeof w === 'function' ? !!w() : !!document.querySelector(w));
    if (elapsed >= rec.opts.timeout) finish(rec, 'timeout');
    else if (ready && rec.quiet >= rec.opts.settleFrames && elapsed >= rec.opts.minDuration) finish(rec, 'settled');
  }

  function animProps(a) {
    if (a.transitionProperty) return [a.transitionProperty];
    const props = new Set();
    try {
      for (const k of a.effect.getKeyframes())
        for (const p of Object.keys(k)) if (!/^(offset|computedOffset|easing|composite)$/.test(p)) props.add(p);
    } catch (_) {
      /* no keyframes */
    }
    return [...props];
  }

  function scanAnimations(rec, f) {
    let running = false;
    let list = [];
    try {
      list = document.getAnimations();
    } catch (_) {
      return false;
    }
    for (const a of list) {
      let info = rec.anims.get(a);
      if (!info) {
        const target = a.effect && a.effect.target;
        let timing = {};
        try {
          timing = a.effect.getComputedTiming();
        } catch (_) {
          /* none */
        }
        // Scroll-driven animations follow scroll, not time: they never "finish" and aren't motion to settle.
        const scrollDriven = !!a.timeline && typeof DocumentTimeline !== 'undefined' && !(a.timeline instanceof DocumentTimeline);
        const infinite = timing.iterations === Infinity || timing.endTime === Infinity;
        const pseudo = (a.effect && a.effect.pseudoElement) || '';
        const props = animProps(a);
        // CSS animations keep their timing function on the keyframes, not the effect.
        let easing = '';
        try {
          easing = a.effect.getTiming().easing;
          if (!easing || easing === 'linear') {
            const k = a.effect.getKeyframes().find((x) => x.easing && x.easing !== 'linear');
            if (k) easing = k.easing;
          }
        } catch (_) {
          /* no timing */
        }
        info = {
          f,
          lastF: f,
          target,
          kind: a.constructor.name,
          props,
          duration: timing.duration,
          delay: timing.delay || 0,
          easing,
          label: a.animationName
            ? `@keyframes ${a.animationName}`
            : a.transitionProperty
              ? `transition ${a.transitionProperty}`
              : `Web Animation${a.id ? ` "${a.id}"` : ''} of ${props.join(', ') || 'unknown properties'}`,
          pseudo,
          infinite,
          scrollDriven,
          vt: pseudo.startsWith('::view-transition'),
        };
        rec.anims.set(a, info);
        // An infinite animation on ::before / ::after is the pseudo's alone; the element still counts.
        if (infinite && target && target.nodeType === 1 && !a.effect.pseudoElement) {
          rec.ignored.add(target);
          for (const tr of rec.tracks.values()) if (target.contains(tr.el)) tr.skip = true;
        }
      }
      if (a.playState === 'running') info.lastF = f;
      if (info.vt && a.playState === 'running') rec.vtFrames.add(f);
      if (!info.infinite && !info.scrollDriven && a.playState === 'running') {
        const tr = info.target && rec.trackOf.get(info.target);
        if (!tr || !tr.skip) running = true;
      }
    }
    return running;
  }

  // Is this box turned (rotate, skew, 3D)? Then width/height ratios aren't a stretch.
  function turned(cs) {
    if (cs.rotate && cs.rotate !== 'none' && !/^0(deg|rad|turn)?$/.test(cs.rotate)) return true;
    const t = cs.transform;
    if (!t || t === 'none') return false;
    const m = t.slice(t.indexOf('(') + 1, -1).split(',').map(Number);
    const off = t.startsWith('matrix3d') ? [1, 2, 4, 6, 8, 9] : [1, 2];
    return off.some((i) => Math.abs(m[i]) > 1e-3);
  }
  const scaled = (cs) => (cs.transform && cs.transform !== 'none') || (cs.scale && cs.scale !== 'none');
  // Establishes a containing block for absolutely (abs) or fixed-positioned (fix) descendants.
  const set = (v) => !!v && v !== 'none';
  const containsFixed = (cs) =>
    set(cs.transform) ||
    set(cs.translate) ||
    set(cs.rotate) ||
    set(cs.scale) ||
    set(cs.filter) ||
    set(cs.backdropFilter) ||
    set(cs.perspective) ||
    cs.transformStyle === 'preserve-3d' ||
    cs.contentVisibility === 'auto' ||
    /paint|layout|strict|content/.test(cs.contain || '') ||
    /transform|translate|rotate|scale|filter|perspective/.test(cs.willChange || '') ||
    (cs.containerType && cs.containerType !== 'normal');
  const containsAbs = (cs) => cs.position !== 'static' || containsFixed(cs);

  function sample(rec, f) {
    const started = performance.now();
    const view = { l: 0, t: 0, r: innerWidth, b: innerHeight };
    // A lane is what clips and scrolls a box: { clip, sc (scroller), sr (its rect) }.
    // Overflow clips and scrolls only descendants whose containing block is inside it, so an
    // absolute element escapes a static overflow:hidden parent, and a fixed one escapes all
    // of them unless an ancestor is transformed. Each element hands three lanes to its
    // children: flow (static and relative), abs and fix.
    const viewLane = { clip: view, sc: null, sr: null };
    const top = { o: 1, rot: false, tf: false, flow: viewLane, abs: viewLane, fix: viewLane };
    const memo = new Map();
    const laneOf = (p, cs) => (cs.position === 'fixed' ? p.fix : cs.position === 'absolute' ? p.abs : p.flow);
    const ctx = (el) => {
      if (!el || el.nodeType !== 1) return top;
      let c = memo.get(el);
      if (c) return c;
      const cs = styleOf(el);
      const p = ctx(el.parentElement);
      const own = laneOf(p, cs);
      let flow = own;
      const ox = cs.overflowX;
      const oy = cs.overflowY;
      if ((ox !== 'visible' || oy !== 'visible') && el !== document.documentElement && el !== document.body) {
        const r = el.getBoundingClientRect();
        const clip = {
          l: ox === 'visible' ? own.clip.l : Math.max(own.clip.l, r.left),
          r: ox === 'visible' ? own.clip.r : Math.min(own.clip.r, r.right),
          t: oy === 'visible' ? own.clip.t : Math.max(own.clip.t, r.top),
          b: oy === 'visible' ? own.clip.b : Math.min(own.clip.b, r.bottom),
        };
        const scrolls = (v) => v === 'auto' || v === 'scroll';
        if ((scrolls(oy) && el.scrollHeight > el.clientHeight) || (scrolls(ox) && el.scrollWidth > el.clientWidth)) {
          flow = { clip, sc: el, sr: r };
          if (!rec.scrollers.has(el)) rec.scrollers.set(el, { el, rows: [], last: null, born: f });
        } else flow = { clip, sc: own.sc, sr: own.sr };
      }
      c = {
        o: p.o * (parseFloat(cs.opacity) || 0),
        rot: p.rot || turned(cs),
        tf: p.tf || scaled(cs),
        flow,
        abs: containsAbs(cs) ? flow : p.abs,
        fix: containsFixed(cs) ? flow : p.fix,
      };
      memo.set(el, c);
      return c;
    };

    let changed = false;
    for (const tr of rec.tracks.values()) {
      if (tr.died !== null || tr.skip) continue;
      const el = tr.el;
      if (!el.isConnected) {
        tr.died = f;
        changed = true;
        continue;
      }
      let row;
      const b = el.getBoundingClientRect();
      // A zero box may still be rendered (an empty inline); only then ask for client rects.
      if (b.width === 0 && b.height === 0 && !el.getClientRects().length) {
        row = [f, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0];
      } else {
        const cs = styleOf(el);
        // Styles can land a frame or two after mount, so look again now and then.
        if (!tr.paints && (tr.paints === undefined || f % 10 === 0)) tr.paints = paints(el, cs);
        const p = ctx(el.parentElement);
        const lane = laneOf(p, cs);
        const o = p.o * (cs.visibility === 'hidden' ? 0 : parseFloat(cs.opacity) || 0);
        const c = lane.clip;
        const iw = Math.max(0, Math.min(b.right, c.r) - Math.max(b.left, c.l));
        const ih = Math.max(0, Math.min(b.bottom, c.b) - Math.max(b.top, c.t));
        let cx, cy;
        if (lane.sc) {
          cx = b.left - lane.sr.left + lane.sc.scrollLeft;
          cy = b.top - lane.sr.top + lane.sc.scrollTop;
        } else if (lane === viewLane && cs.position === 'fixed') {
          cx = b.left;
          cy = b.top;
        } else {
          cx = b.left + scrollX;
          cy = b.top + scrollY;
        }
        let k = 1;
        // Text can only be stretched by a scale transform on itself or an ancestor.
        if (tr.text && (p.tf || scaled(cs)) && !p.rot && !turned(cs)) {
          const ow = el.offsetWidth;
          const oh = el.offsetHeight;
          // offsetWidth/Height are rounded; within a pixel of the box there is no scale at all.
          if (ow > 0 && oh > 0 && b.height > 0 && (Math.abs(b.width - ow) >= 1 || Math.abs(b.height - oh) >= 1))
            k = b.width / ow / (b.height / oh);
        }
        row = [f, b.left, b.top, cx, cy, b.width, b.height, o, iw * ih, k, 1];
      }
      const prev = tr.last;
      if (!prev || differs(prev, row)) {
        tr.rows.push(row);
        tr.last = row;
        if (prev || f > 0) changed = true;
      }
    }
    const winRow = [f, scrollY, scrollX];
    if (!rec.win) rec.win = { el: null, rows: [winRow], last: winRow, born: f };
    else if (rec.win.last[1] !== winRow[1] || rec.win.last[2] !== winRow[2]) {
      rec.win.rows.push(winRow);
      rec.win.last = winRow;
      changed = true;
    }
    for (const s of rec.scrollers.values()) {
      if (!s.el.isConnected) continue;
      const row = [f, s.el.scrollTop, s.el.scrollLeft];
      if (!s.last || s.last[1] !== row[1] || s.last[2] !== row[2]) {
        s.rows.push(row);
        if (s.last) changed = true;
        s.last = row;
      }
    }
    rec.overhead.push(performance.now() - started);
    return changed;
  }

  function differs(a, b) {
    if (a[R] !== b[R]) return true;
    for (let i = VX; i <= H; i++) if (Math.abs(a[i] - b[i]) > 0.01) return true;
    return Math.abs(a[O] - b[O]) > 0.001 || Math.abs(a[A] - b[A]) > 0.5 || Math.abs(a[K] - b[K]) > 0.001;
  }

  function finish(rec, status, error) {
    if (rec.status !== 'recording') return;
    // Entries the browser has queued but not yet delivered still belong to this recording.
    for (const { po, handle } of rec.observers) {
      try {
        handle(po.takeRecords());
      } catch (_) {
        /* nothing queued */
      }
      po.disconnect();
    }
    rec.status = status;
    if (error) rec.error = error;
    cancelAnimationFrame(rec.raf);
    clearTimeout(rec.backstop);
    if (rec.mo) rec.mo.disconnect();
    if (rec.onHide) document.removeEventListener('visibilitychange', rec.onHide);
    if (rec.onInput) for (const type of INPUTS) window.removeEventListener(type, rec.onInput, { capture: true });
    if (rec.channel) rec.channel.port1.onmessage = null;
    if (current === rec) current = null;
    for (const tr of rec.tracks.values())
      if (!tr.paints && tr.el.isConnected && tr.el.getClientRects().length) tr.paints = paints(tr.el, styleOf(tr.el));
    try {
      rec.result = analyze(rec);
    } catch (e) {
      rec.result = { version: VERSION, status: 'error', error: String((e && e.stack) || e), findings: [], expectations: [] };
    }
    last = rec;
    rec.resolve(rec.result);
  }

  // ---------- analysis ----------

  const median = (xs) => {
    if (!xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const round = (n, d = 0) => {
    const p = 10 ** d;
    return Math.round(n * p) / p;
  };
  const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

  // Per-frame values for one element (null where it isn't on the page or isn't rendered).
  function series(rec, tr) {
    const F = rec.frames.length;
    const s = { vx: [], vy: [], cx: [], cy: [], w: [], h: [], o: [], a: [], k: [], alive: [], rendered: [] };
    let ri = 0;
    let cur = null;
    for (let f = 0; f < F; f++) {
      while (ri < tr.rows.length && tr.rows[ri][F_] <= f) cur = tr.rows[ri++];
      const alive = !!cur && f >= tr.born && (tr.died === null || f < tr.died);
      const on = alive && cur[R] === 1;
      s.alive.push(alive);
      s.rendered.push(on);
      s.vx.push(on ? cur[VX] : null);
      s.vy.push(on ? cur[VY] : null);
      s.cx.push(on ? cur[CX] : null);
      s.cy.push(on ? cur[CY] : null);
      s.w.push(on ? cur[W] : null);
      s.h.push(on ? cur[H] : null);
      s.o.push(on ? cur[O] : 0);
      s.a.push(on ? cur[A] : 0);
      s.k.push(on ? cur[K] : 1);
    }
    return s;
  }

  const pathLength = (xs) => {
    let p = 0;
    for (let i = 1; i < xs.length; i++) if (xs[i] != null && xs[i - 1] != null) p += Math.abs(xs[i] - xs[i - 1]);
    return p;
  };

  // How long each frame took compared with a typical one (1 = normal, 2 = a dropped frame).
  // A frame that took twice as long moves twice as far without being a jump.
  function frameWeights(ts) {
    const dts = [];
    for (let i = 1; i < ts.length; i++) dts.push(ts[i] - ts[i - 1]);
    const typical = median(dts.filter((d) => d > 1)) || 16.7;
    return ts.map((t, i) => (i === 0 ? 1 : Math.min(4, Math.max(0.5, (t - ts[i - 1]) / typical))));
  }

  // Movement events along one axis. Each event: { type, f, amount, ... }.
  function axisEvents(xs, T, wt) {
    const out = [];
    const F = xs.length;
    wt = wt || xs.map(() => 1);
    let f = 0;
    while (f < F) {
      if (xs[f] == null) {
        f++;
        continue;
      }
      let g = f;
      while (g + 1 < F && xs[g + 1] != null) g++;
      segmentEvents(xs, f, g, T, out, wt);
      f = g + 1;
    }
    return out;
  }

  function segmentEvents(xs, a, b, T, out, wt) {
    const d = (i) => xs[i] - xs[i - 1];
    const speed = (i) => Math.abs(d(i)) / wt[i];
    const used = new Set();
    // Shiver: the direction flips on consecutive frames, as when two things fight over a value.
    for (let i = a + 1; i <= b; ) {
      let j = i;
      while (
        j + 1 <= b &&
        Math.abs(d(j)) >= 2 * T.eps &&
        Math.abs(d(j + 1)) >= 2 * T.eps &&
        sign(d(j + 1)) === -sign(d(j))
      )
        j++;
      if (j - i >= 3) {
        let amp = 0;
        for (let k = i; k <= j; k++) amp = Math.max(amp, Math.abs(d(k)));
        out.push({ type: 'oscillation', f: i, amount: amp, count: j - i + 1 });
        for (let k = i; k <= j; k++) used.add(k);
        i = j + 1;
      } else i++;
    }
    // Blips: off by a clear amount, then back where it was within a few frames.
    for (let i = a + 1; i <= b; i++) {
      const di = d(i);
      if (Math.abs(di) < Math.max(T.shift, 4) || used.has(i)) continue;
      const base = xs[i - 1];
      for (let j = i + 1; j <= Math.min(b, i + T.blipFrames); j++) {
        if (Math.abs(xs[j] - base) <= Math.max(1, 0.2 * Math.abs(di))) {
          let away = true;
          for (let k = i; k < j; k++) if (Math.abs(xs[k] - base) < 0.5 * Math.abs(di)) away = false;
          if (away) {
            out.push({ type: 'blip', f: i, amount: di, frames: j - i });
            for (let k = i; k <= j; k++) used.add(k);
          }
          break;
        }
      }
    }
    // Spikes: one frame far off the line through its neighbours while moving, as when a
    // frame paints before its transform is set (a late FLIP mid-animation).
    for (let i = a + 1; i < b; i++) {
      if (used.has(i) || used.has(i + 1)) continue;
      const dev = xs[i] - (xs[i - 1] + xs[i + 1]) / 2;
      if (sign(d(i)) !== -sign(d(i + 1))) continue;
      const near = [];
      if (i - 1 > a) near.push(Math.abs(d(i - 1)));
      if (i + 2 <= b) near.push(Math.abs(d(i + 2)));
      const m = near.length ? Math.max(...near) : 0;
      // Both the step out and the step back are big: an end snap steps out by a pixel.
      const out2 = Math.min(Math.abs(d(i)), Math.abs(d(i + 1)));
      if (Math.abs(dev) >= Math.max(T.shift, 4) && Math.abs(dev) >= 3 * Math.max(m, T.eps) && out2 >= 2 * Math.max(m, T.eps)) {
        out.push({ type: 'blip', f: i, amount: dev, frames: 1 });
        used.add(i);
        used.add(i + 1);
      }
    }
    // Runs of consecutive moving frames.
    const runs = [];
    let run = null;
    for (let i = a + 1; i <= b; i++) {
      const moving = !used.has(i) && Math.abs(d(i)) > T.eps;
      if (moving) {
        if (run && run.q === i - 1) run.q = i;
        else runs.push((run = { p: i, q: i }));
      }
    }
    for (let ri = 0; ri < runs.length; ri++) {
      const r = runs[ri];
      const prev = runs[ri - 1];
      const next = runs[ri + 1];
      const len = r.q - r.p + 1;
      const travel = xs[r.q] - xs[r.p - 1];
      if (prev && r.p - prev.q - 1 >= T.restFrames && Math.abs(travel) >= 1 && (len > 1 || Math.abs(travel) < T.shift)) {
        out.push({ type: 'resettle', f: r.p, amount: travel, rest: r.p - prev.q - 1 });
      }
      if (len === 1) {
        const di = d(r.p);
        if (Math.abs(di) < T.shift) continue;
        // A one-frame move right after a move ends (or right before one starts) belongs to it.
        if (prev && prev.q > prev.p && r.p - prev.q - 1 <= 3)
          out.push({ type: 'jump', f: r.p, amount: di, where: 'end', travel: xs[r.p] - xs[prev.p - 1], perFrame: Math.abs(d(prev.q)) });
        else if (next && next.q > next.p && next.p - r.q - 1 <= 2)
          out.push({ type: 'jump', f: r.p, amount: di, where: 'start', travel: xs[next.q] - xs[r.p - 1], perFrame: Math.abs(d(next.p)) });
        else out.push({ type: 'shift', f: r.p, amount: di });
        continue;
      }
      let jumpAt = -1;
      for (let i = r.p; i <= r.q; i++) {
        // Compared with its neighbours, so a fast middle of an eased move isn't a jump; per
        // unit of time, so a dropped frame isn't one either.
        // The excess over what this frame's duration explains, so a snap right after a stall
        // still counts.
        const near = [];
        for (const k of [i - 2, i - 1, i + 1, i + 2]) if (k >= r.p && k <= r.q) near.push(speed(k));
        const m = median(near);
        const excess = Math.abs(d(i)) - m * wt[i];
        if (near.length && excess >= Math.max(T.jumpMin, (T.jumpRatio - 1) * Math.max(m, T.eps))) {
          out.push({ type: 'jump', f: i, amount: d(i), where: i === r.p ? 'start' : i === r.q ? 'end' : 'mid', travel, perFrame: m });
          jumpAt = i;
        }
      }
      // Direction changes.
      const dir = sign(travel) || sign(d(r.p));
      const turns = [];
      let lastSign = 0;
      for (let i = r.p; i <= r.q; i++) {
        const s = sign(d(i));
        if (Math.abs(d(i)) <= T.eps * 0.5) continue;
        if (lastSign && s !== lastSign) turns.push(i);
        lastSign = s;
      }
      if (turns.length && Math.abs(travel) >= T.shift && !(jumpAt === r.p && turns[0] === r.p + 1)) {
        const t0 = turns[0];
        const progress = (xs[t0 - 1] - xs[r.p - 1]) / travel;
        if (progress < T.reversalBefore && progress > -0.5) {
          let back = 0;
          for (let i = t0; i <= r.q && sign(d(i)) !== dir; i++) back += Math.abs(d(i));
          if (back >= 1) out.push({ type: 'reversal', f: t0, amount: back, progress, travel });
        }
      }
      if (turns.length >= 3) {
        const amps = [];
        let ext = xs[r.p - 1];
        for (const t of turns) {
          amps.push(Math.abs(xs[t - 1] - ext));
          ext = xs[t - 1];
        }
        const tail = amps.slice(1);
        const decaying = tail.every((v, i) => v <= amps[i] * 0.8);
        if (!decaying && Math.max(...tail) >= 2) out.push({ type: 'oscillation', f: turns[0], amount: Math.max(...tail), count: turns.length });
      }
      if (Math.abs(travel) >= T.shift) {
        let over = 0;
        let at = r.p;
        for (let i = r.p; i <= r.q; i++) {
          const v = (xs[i] - xs[r.q]) * dir;
          if (v > over) {
            over = v;
            at = i;
          }
        }
        if (over > Math.max(T.overshootMin, T.overshoot * Math.abs(travel))) out.push({ type: 'overshoot', f: at, amount: over, travel });
      }
    }
  }

  function presenceEvents(s, f0, T, scrolled) {
    const out = [];
    const F = s.o.length;
    const vis = s.o.map((o, f) => s.rendered[f] && s.a[f] > 0 && o >= 0.05);
    const hiddenBy = (f) => (!s.alive[f] ? 'gone' : !s.rendered[f] ? 'unrendered' : s.o[f] < 0.05 ? 'transparent' : 'clipped');
    const skip = new Set(); // the return half of a flicker
    for (let f = Math.max(1, f0); f < F; f++) {
      if (skip.has(f)) continue;
      if (vis[f] && !vis[f - 1]) {
        const why = hiddenBy(f - 1);
        // Something that became visible by scrolling or a growing clip is not a pop.
        if (why === 'clipped' && (scrolled[f] || s.a[f] < 0.5 * Math.max(...s.a.slice(f, f + 10)))) continue;
        let end = f;
        while (end + 1 < F && vis[end + 1]) end++;
        const shown = end - f + 1;
        if (end < F - 1 && shown <= 2 && s.o[f] >= 0.3) {
          out.push({ type: 'flash', f, frames: shown, area: s.a[f] });
          skip.add(end + 1); // its disappearance is part of the flash
          continue;
        }
        const maxA = Math.max(...s.a.slice(f, Math.min(F, f + 10)));
        if (s.o[f] >= 0.9 && s.a[f] >= T.popArea && s.a[f] >= 0.5 * maxA)
          out.push({ type: 'pop-in', f, area: s.a[f], w: s.w[f], h: s.h[f], why });
      } else if (!vis[f] && vis[f - 1]) {
        const why = hiddenBy(f);
        if (why === 'clipped' && scrolled[f]) continue;
        // Back within a few frames: a flicker, not a removal.
        let back = -1;
        for (let j = f + 1; j <= Math.min(F - 1, f + T.blipFrames - 1); j++) if (vis[j]) {
          back = j;
          break;
        }
        if (back > 0 && s.o[f - 1] >= 0.5) {
          out.push({ type: 'flicker', f, frames: back - f, from: s.o[f - 1], to: 0 });
          skip.add(back);
          continue;
        }
        if (s.o[f - 1] >= 0.9 && s.a[f - 1] >= T.popArea)
          out.push({ type: 'pop-out', f, area: s.a[f - 1], w: s.w[f - 1], h: s.h[f - 1], why });
      } else if (vis[f] && vis[f - 1]) {
        const dOp = s.o[f] - s.o[f - 1];
        if (Math.abs(dOp) >= T.flicker) {
          let back = -1;
          for (let j = f + 1; j <= Math.min(F - 1, f + T.blipFrames - 1); j++)
            if (Math.abs(s.o[j] - s.o[f - 1]) <= 0.1) {
              back = j;
              break;
            }
          if (back > 0) {
            out.push({ type: 'flicker', f, frames: back - f, from: s.o[f - 1], to: s.o[f] });
            skip.add(back);
          } else if (Math.abs(dOp) >= 0.5) out.push({ type: 'opacity-snap', f, from: s.o[f - 1], to: s.o[f] });
        }
      }
    }
    return out;
  }

  function stretchEvents(s, T) {
    const out = [];
    const F = s.k.length;
    let endK = 1;
    for (let f = F - 1; f >= 0; f--) if (s.rendered[f]) {
      endK = s.k[f];
      break;
    }
    let runStart = -1;
    let worst = 0;
    for (let f = 0; f <= F; f++) {
      const dev = f < F && s.rendered[f] && s.a[f] > 0 ? Math.abs(s.k[f] - endK) : 0;
      if (dev > T.stretch) {
        if (runStart < 0) runStart = f;
        worst = Math.max(worst, dev);
      } else if (runStart >= 0) {
        if (f - runStart >= 2) out.push({ type: 'stretch', f: runStart, frames: f - runStart, amount: worst });
        runStart = -1;
        worst = 0;
      }
    }
    return out;
  }

  function analyze(rec) {
    const T = rec.opts.thresholds;
    const F = rec.frames.length;
    const wt = frameWeights(rec.frames);
    const findings = [];
    // Never settled: elements that changed in most frames are loops (a JS ticker, a marquee),
    // not transitions. Leave them out instead of reporting every frame of them.
    // Each element is judged on its own movement and opacity: a parent that only grows
    // because a child streams text is not a loop, and neither are its other children.
    const loops = [];
    if (rec.status === 'timeout') {
      for (const t of rec.tracks.values()) {
        const span = (t.died === null ? F : t.died) - t.born;
        if (t.skip || span < 60) continue;
        let own = 0;
        for (let i = 1; i < t.rows.length; i++) {
          const a = t.rows[i - 1];
          const b = t.rows[i];
          if (Math.abs(a[VX] - b[VX]) > 0.01 || Math.abs(a[VY] - b[VY]) > 0.01 || Math.abs(a[O] - b[O]) > 0.001) own++;
        }
        if (own >= 0.6 * span) loops.push(t);
      }
    }
    rec.loops = new Set(loops);
    const tracks = [...rec.tracks.values()].filter((t) => !t.skip && !rec.loops.has(t));
    const scrolled = new Array(F).fill(false);
    const scrollSources = [...rec.scrollers.values()];
    if (rec.win) scrollSources.push(rec.win);
    for (const sc of scrollSources) for (let i = 1; i < sc.rows.length; i++) scrolled[sc.rows[i][0]] = true;

    const S = new Map();
    const sizeChanged = new Array(F).fill(null).map(() => []);
    for (const tr of tracks) {
      const s = series(rec, tr);
      S.set(tr, s);
      for (let f = 1; f < F; f++)
        if (s.h[f] != null && s.h[f - 1] != null && (Math.abs(s.h[f] - s.h[f - 1]) >= 1 || Math.abs(s.w[f] - s.w[f - 1]) >= 1))
          sizeChanged[f].push(tr);
    }

    const visibleAt = (s, f) => s.a[f] > 0 || (f > 0 && s.a[f - 1] > 0);
    // During a main-thread stall the compositor keeps CSS and Web Animations of transform and
    // opacity moving on screen; the probe only sees where they got to afterwards. A jump right
    // after a slow frame on such an element isn't visible, so it is left out (the slow frame
    // is still reported).
    const COMPOSITED = /^(transform|translate|rotate|scale|opacity|filter)$/;
    const composited = [...rec.anims.values()].filter(
      (i) => !i.scrollDriven && !i.vt && i.target && i.target.nodeType === 1 && i.props.length && i.props.every((p) => COMPOSITED.test(p))
    );
    const stalled = (f) => f > 0 && rec.frames[f] - rec.frames[f - 1] >= T.slowFrame;
    const offThread = (tr) => composited.some((i) => i.target.contains(tr.el));
    let stallJumps = 0;
    for (const tr of tracks) {
      const moved = tr.rows.length > 1 || tr.born > 0 || tr.died !== null;
      if (!moved || !tr.paints) continue;
      const s = S.get(tr);
      if (!s.a.some((a) => a > 0)) continue; // never on screen
      const add = (e, axis) => findings.push({ ...e, axis, tr });
      for (const axis of ['x', 'y']) {
        const v = axis === 'x' ? s.vx : s.vy;
        const c = axis === 'x' ? s.cx : s.cy;
        const xs = pathLength(c) <= pathLength(v) ? c : v;
        for (const e of axisEvents(xs, T, wt)) {
          if (!visibleAt(s, e.f)) continue;
          if ((e.type === 'jump' || e.type === 'shift') && stalled(e.f) && offThread(tr)) {
            stallJumps++;
            continue;
          }
          add(e, axis);
        }
      }
      for (const e of presenceEvents(s, tr.born === 0 ? 1 : tr.born + 1 > 1 ? tr.born : 1, T, scrolled)) {
        // Elements present in the first frame they were tracked (page load) are the baseline.
        if ((e.type === 'pop-in' || e.type === 'flash') && e.f === tr.born && tr.born === firstFrameOf(rec)) continue;
        add(e, null);
      }
      if (tr.text) for (const e of stretchEvents(s, T)) add(e, null);
    }

    // Scroll anchoring moves the scroll position to cancel out an insertion above: content
    // is pushed down in the page by the same amount and stays put on screen. Only that
    // evidence silences a scroll jump, so a narrow root (or a fixed one) can't hide a real one.
    const anchored = (sc, f, axis, delta) => {
      let still = false;
      for (const t of tracks) {
        if (!t.paints || (sc.el && !sc.el.contains(t.el))) continue;
        const s = S.get(t);
        const v = axis === 'x' ? s.vx : s.vy;
        const c = axis === 'x' ? s.cx : s.cy;
        if (!(s.a[f] > 0 || s.a[f - 1] > 0) || v[f] == null || v[f - 1] == null) continue;
        if (Math.abs(v[f] - v[f - 1]) >= T.shift) return false; // something visibly moved
        if (Math.abs(c[f] - c[f - 1] - delta) <= Math.max(2, 0.1 * Math.abs(delta))) still = true;
      }
      return still;
    };
    for (const sc of scrollSources) {
      const name = sc.el ? describe(sc.el) : 'window';
      for (const [col, axis] of [[1, 'y'], [2, 'x']]) {
        const xs = new Array(F).fill(null);
        let ri = 0;
        let cur = null;
        for (let f = sc.born; f < F; f++) {
          while (ri < sc.rows.length && sc.rows[ri][0] <= f) cur = sc.rows[ri++];
          xs[f] = cur ? cur[col] : null;
        }
        for (const e of axisEvents(xs, { ...T, shift: T.scrollJump, jumpMin: T.scrollJump }, wt)) {
          if (e.type === 'shift' || e.type === 'jump' || e.type === 'blip') {
            if (!anchored(sc, e.f, axis, e.amount)) findings.push({ type: 'scroll-jump', f: e.f, amount: e.amount, axis, scroller: name });
          } else if (e.type === 'oscillation' || (e.type === 'reversal' && e.amount >= 4))
            findings.push({ type: 'scroll-fight', f: e.f, amount: e.amount, count: e.count || 1, axis, scroller: name });
        }
      }
    }

    // Swaps: one element pops out while another of a similar size pops in at the same place.
    // Matching isn't one-to-one: nested old elements can all be replaced by one new element.
    const pops = findings.filter((x) => x.type === 'pop-in');
    const reported = new Set();
    for (const out of findings.filter((x) => x.type === 'pop-out')) {
      const ro = boxAt(S.get(out.tr), out.f - 1);
      if (!ro) continue;
      let best = null;
      let seamless = false;
      for (const inn of pops) {
        if (Math.abs(inn.f - out.f) > 2) continue;
        const ri = boxAt(S.get(inn.tr), inn.f);
        if (!ri || overlap(ro, ri) < 0.5 || Math.abs(ri.w * ri.h - ro.w * ro.h) > 0.3 * Math.max(ri.w * ri.h, ro.w * ro.h)) continue;
        inn.swapped = out.swapped = true;
        // Same box, tag and text: one copy handing over to another (a remount).
        const lookAlike =
          Math.abs(ri.x - ro.x) <= 2 && Math.abs(ri.y - ro.y) <= 2 && Math.abs(ri.w - ro.w) <= 2 && Math.abs(ri.h - ro.h) <= 2 &&
          inn.tr.el.localName === out.tr.el.localName &&
          (inn.tr.el.textContent || '').trim() === (out.tr.el.textContent || '').trim();
        if (lookAlike) {
          // Seamless only if the new copy shows by the frame the old one is gone.
          seamless = true;
          if (inn.f > out.f && !reported.has(inn)) {
            reported.add(inn);
            findings.push({ type: 'flicker', f: out.f, frames: inn.f - out.f, from: 1, to: 0, remount: true, tr: inn.tr });
          }
        } else if (!best || overlap(ro, ri) > best.score) best = { inn, score: overlap(ro, ri) };
      }
      if (!seamless && best && !reported.has(best.inn)) {
        reported.add(best.inn);
        findings.push({ type: 'swap', f: best.inn.f, from: descOf(out.tr), tr: best.inn.tr });
      }
    }

    // Long animation frames, without the probe's own callbacks: their reads can force a
    // layout the page left pending, and that cost is the page's, not a script to blame.
    const own = (s) => rec.spans.some(([a, b]) => s.start <= a + 1 && s.start + s.duration >= b - 1 && s.duration <= b - a + 3);
    for (const l of rec.loafs) {
      const page = (l.all || []).filter((s) => !own(s));
      l.forced = page.reduce((n, s) => n + s.forced, 0);
      l.scripts = page
        .slice()
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 2)
        .map((s) => ({ duration: Math.round(s.duration), forced: Math.round(s.forced), name: s.name, source: s.source }));
    }
    const slow = rec.loafs.filter((l) => l.duration >= T.slowFrame);
    if (slow.length) {
      const worst = slow.reduce((a, b) => (b.duration > a.duration ? b : a));
      // The script that forced the most layout, which may not be the longest one.
      const thrash = worst.scripts.slice().sort((a, b) => b.forced - a.forced)[0];
      findings.push({
        type: 'slow-frame',
        f: frameAt(rec, worst.t),
        amount: worst.duration,
        count: slow.length,
        script: scriptName(worst.scripts[0]),
        forced: worst.forced >= T.forcedLayout ? worst.forced : 0,
        forcedBy: worst.forced >= T.forcedLayout && thrash && thrash !== worst.scripts[0] ? scriptName(thrash) : '',
      });
    }

    // Inputs that took too long to show anything. The response is the first frame after the
    // input in which something visibly changed that wasn't already changing in the second
    // before it: a ticking clock, a running transition or a scroll in progress isn't a
    // response. It has to come before the next input and within 3s.
    const changers = rec.frames.map(() => []);
    const shownRow = (r) => !!r && r[R] === 1 && r[O] > 0 && r[A] > 0;
    for (const tr of rec.tracks.values()) {
      if (!tr.paints || tr.skip) continue;
      let prev = null;
      for (const r of tr.rows) {
        if (r[F_] > 0 && r[F_] < F && (shownRow(r) || shownRow(prev))) changers[r[F_]].push(tr);
        prev = r;
      }
    }
    for (const sc of [rec.win, ...rec.scrollers.values()]) if (sc) for (const r of sc.rows.slice(1)) if (r[0] < F) changers[r[0]].push(sc);
    rec.mutations.forEach((m, f) => {
      if (m && f < F) for (const el of m.text) if (el.isConnected && inRoots(rec, el) && !ignoredEl(rec, el)) changers[f].push(el);
    });
    const lastSampleBy = (t) => {
      let f = -1;
      while (f + 1 < F && rec.sampledAt[f + 1] <= t) f++;
      return f;
    };
    for (let i = 0; i < rec.inputs.length; i++) {
      const inp = rec.inputs[i];
      const next = rec.inputs[i + 1];
      const fIn = lastSampleBy(inp.start);
      const busy = new Set();
      for (let f = fIn; f >= 0 && rec.sampledAt[f] >= inp.start - 1000; f--) for (const c of changers[f]) busy.add(c);
      let resp = -1;
      for (let f = fIn + 1; f < F; f++) {
        if ((next && rec.sampledAt[f] > next.start) || rec.sampledAt[f] - inp.end > 3000) break;
        if (changers[f].some((c) => !busy.has(c))) {
          resp = f;
          break;
        }
      }
      if (resp < 0) continue;
      // Timed to when the frame was sampled, just after it painted. A frame's rAF timestamp
      // can be far earlier than its paint when the main thread was blocked.
      const shown = rec.sampledAt[resp];
      const delay = Math.max(0, shown - inp.end);
      if (delay < T.slowResponse) continue;
      // A slow frame in between is why: the main thread couldn't render the response.
      const blocked = rec.loafs
        .filter((l) => l.t < shown && l.t + l.duration > inp.end && l.duration >= T.slowFrame)
        .sort((a, b) => b.duration - a.duration)[0];
      findings.push({
        type: 'slow-response',
        f: frameAt(rec, inp.end),
        amount: delay,
        input: inp.input,
        el: null,
        target: inp.target,
        cause: blocked
          ? { text: `main thread busy for ${Math.round(blocked.duration)}ms${blocked.scripts[0] ? ` in ${scriptName(blocked.scripts[0])}` : ''}`, sure: true }
          : '',
      });
    }

    const seenAnim = new Set();
    for (const info of rec.anims.values()) {
      if (info.infinite || info.scrollDriven || info.vt || !info.target || info.target.nodeType !== 1) continue;
      const layout = info.props.map((p) => p.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())).filter((p) => LAYOUT_PROP.test(p));
      if (!layout.length) continue;
      const key = idOf(info.target) + layout.join();
      if (seenAnim.has(key)) continue;
      seenAnim.add(key);
      findings.push({ type: 'layout-anim', f: info.f, props: layout, el: info.target, animation: animLabel(info, info.target) });
    }

    // While a View Transition runs, the screen shows its ::view-transition pseudo-elements
    // (snapshots), not the live elements underneath, so element findings from that window
    // say nothing about what was seen. The DOM swap lands a frame or two before its
    // animations start.
    const vt = [...rec.vtFrames].sort((a, b) => a - b);
    const inVT = (f) => vt.length > 0 && f >= vt[0] - 3 && f <= vt[vt.length - 1] + 1;
    let vtLeftOut = 0;
    const kept = findings.filter((x) => {
      if (x.swapped && (x.type === 'pop-in' || x.type === 'pop-out')) return false;
      if ((x.tr || x.type === 'swap') && inVT(x.f)) {
        vtLeftOut++;
        return false;
      }
      return true;
    });
    const out = finalize(rec, kept, S, sizeChanged, T);
    const result = {
      version: VERSION,
      status: rec.status,
      error: rec.error,
      duration: Math.round(rec.frames[F - 1] || 0),
      frames: F,
      elements: rec.tracks.size,
      truncated: rec.truncated,
      probeMs: {
        avg: round(rec.overhead.reduce((a, b) => a + b, 0) / Math.max(1, rec.overhead.length), 2),
        max: round(Math.max(0, ...rec.overhead), 2),
      },
      env: rec.env,
      findings: out,
      counts: { high: 0, medium: 0, low: 0 },
      expectations: rec.opts.expect ? check(rec, rec.opts.expect, S, out) : [],
      stallJumps,
      viewTransition: vt.length
        ? { from: Math.round(rec.frames[vt[0]] || 0), to: Math.round(rec.frames[vt[vt.length - 1]] || 0), leftOut: vtLeftOut }
        : null,
      loops: loops.filter((t) => !loops.some((o) => o.el !== t.el && o.el.contains(t.el))).slice(0, 5).map(descOf),
      layoutShifts: rec.layoutShifts.map((l) => ({ ...l, t: Math.round(l.t), value: round(l.value, 4) })),
      slowFrames: rec.loafs.map(({ all, ...l }) => ({ ...l, t: Math.round(l.t), duration: Math.round(l.duration), forced: Math.round(l.forced || 0) })),
      inputs: rec.inputs.map((i) => ({ input: i.input, target: i.target, start: Math.round(i.start), end: Math.round(i.end) })),
      animations: [...rec.anims.values()]
        .filter((i) => i.target && i.target.nodeType === 1)
        .slice(0, 50)
        .map((i) => ({
          element: describe(i.target) + i.pseudo,
          kind: i.kind,
          name: i.label,
          props: i.props,
          duration: i.duration,
          delay: i.delay,
          easing: i.easing,
          infinite: i.infinite,
          t: Math.round(rec.frames[i.f] || 0),
        })),
    };
    for (const x of out) result.counts[x.severity]++;
    if (rec.status === 'timeout') {
      const tail = F - Math.min(F, rec.opts.settleFrames);
      const busy = tracks.filter((t) => t.paints && t.rows.length > 1 && t.rows[t.rows.length - 1][F_] >= tail);
      result.stillChanging = busy
        .filter((t) => !busy.some((o) => o.el !== t.el && o.el.contains(t.el)))
        .slice(0, 5)
        .map(descOf);
      for (const [anim, a] of rec.anims)
        if (anim.playState === 'running' && !a.infinite && !a.scrollDriven && a.target && a.target.nodeType === 1) {
          const name = `${describe(a.target)} (running ${a.kind})`;
          if (!result.stillChanging.includes(name) && result.stillChanging.length < 8) result.stillChanging.push(name);
        }
    }
    return result;
  }

  const scriptName = (sc) => (!sc ? '' : sc.name ? `${sc.name}${sc.source ? ` (${sc.source})` : ''}` : sc.source);

  // "transition transform 300ms ease-out on div.card": enough to find it in the CSS or code.
  function animLabel(info, el) {
    const ms = (n) => (typeof n === 'number' && isFinite(n) ? `${Math.round(n)}ms` : '');
    const parts = [info.label, ms(info.duration), info.delay ? `after ${ms(info.delay)}` : '', info.easing];
    const on = info.target !== el || info.pseudo ? ` on ${describe(info.target)}${info.pseudo}` : '';
    return parts.filter(Boolean).join(' ') + on;
  }

  // The animation that was moving this element (or an ancestor) around frame f, if any:
  // the closest one to the element wins.
  // ::before / ::after animations move only the pseudo-element, so they're left out.
  function animFor(rec, el, f, type) {
    const props = FADES.has(type) ? FADE_PROPS : MOVE_PROPS;
    let best = null;
    for (const info of rec.anims.values()) {
      const t = info.target;
      if (info.infinite || info.scrollDriven || info.pseudo || !t || t.nodeType !== 1 || !t.contains(el)) continue;
      if (f < info.f - 1 || f > info.lastF + 1 || !info.props.some((p) => props.test(p))) continue;
      if (!best || (best.target !== t && best.target.contains(t)) || (best.target === t && info.f > best.f)) best = info;
    }
    return best ? animLabel(best, el) : '';
  }

  const firstFrameOf = (rec) => {
    let min = Infinity;
    for (const tr of rec.tracks.values()) min = Math.min(min, tr.born);
    return min === Infinity ? 0 : min;
  };
  const frameAt = (rec, t) => {
    let f = 0;
    while (f + 1 < rec.frames.length && rec.frames[f + 1] <= t) f++;
    return f;
  };
  const boxAt = (s, f) => (s && f >= 0 && s.w[f] != null ? { x: s.vx[f], y: s.vy[f], w: s.w[f], h: s.h[f] } : null);
  function overlap(a, b) {
    const iw = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const ih = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const m = Math.min(a.w * a.h, b.w * b.h);
    return m > 0 ? (iw * ih) / m : 0;
  }

  function severity(x, T) {
    const n = Math.abs(x.amount || 0);
    switch (x.type) {
      case 'blip':
      case 'flash':
      case 'flicker':
      case 'oscillation':
      case 'scroll-fight':
        return 'high';
      case 'shift':
        return n >= T.bigShift ? 'high' : 'medium';
      case 'jump':
        return n >= T.bigJump ? 'high' : 'medium';
      case 'opacity-snap':
        return Math.min(x.from, x.to) >= 0.3 ? 'low' : 'medium';
      case 'reversal':
      case 'stretch':
      case 'scroll-jump':
      case 'swap':
        return 'medium';
      case 'pop-in':
      case 'pop-out':
        return x.area >= T.bigArea ? 'medium' : 'low';
      case 'resettle':
        return n >= 4 ? 'medium' : 'low';
      case 'slow-frame':
        return n >= 100 ? 'medium' : 'low';
      case 'slow-response':
        return n >= 300 ? 'medium' : 'low';
      default:
        return 'low';
    }
  }

  const dirWord = (axis, n) => (axis === 'y' ? (n > 0 ? 'down' : 'up') : n > 0 ? 'right' : 'left');
  const px = (n) => `${round(Math.abs(n), Math.abs(n) < 10 ? 1 : 0)}px`;
  const pct = (n) => `${Math.round(n * 100)}%`;

  function message(x) {
    const n = x.amount;
    switch (x.type) {
      case 'shift':
        return `moved ${dirWord(x.axis, n)} ${px(n)} in one frame, with no transition`;
      case 'blip':
        return `sat ${px(n)} ${x.axis === 'y' ? (n > 0 ? 'below' : 'above') : n > 0 ? 'right of' : 'left of'} its place for ${x.frames} frame${x.frames > 1 ? 's' : ''}, then snapped back`;
      case 'jump':
        if (x.where === 'start') return `first step jumped ${px(n)}, then it animated (wrong start?)`;
        if (x.where === 'end') return `snapped ${px(n)} at the end of its move (was ~${px(x.perFrame)}/frame)`;
        return `jumped ${px(n)} in one frame mid-move (moving ~${px(x.perFrame)}/frame)`;
      case 'reversal':
        return `turned back ${px(n)} after ${pct(x.progress)} of a ${px(x.travel)} move`;
      case 'oscillation':
        return `went back and forth ${x.count} times (±${px(n)}) without settling`;
      case 'overshoot':
        return `overshot ${px(n)} past the end of a ${px(x.travel)} move`;
      case 'resettle':
        return `moved again ${px(n)} after resting ${x.rest} frames`;
      case 'stretch':
        return `text stretched ${pct(x.amount)} out of proportion for ${x.frames} frames (scaleX ≠ scaleY)`;
      case 'pop-in':
        return `appeared at full opacity with no fade (${Math.round(x.w)}×${Math.round(x.h)})`;
      case 'pop-out':
        return `disappeared at full opacity with no fade (${Math.round(x.w)}×${Math.round(x.h)})`;
      case 'flash':
        return `was visible for only ${x.frames} frame${x.frames > 1 ? 's' : ''}`;
      case 'flicker':
        if (x.remount) return `went blank for ${x.frames} frame${x.frames > 1 ? 's' : ''}: remounted as an identical copy`;
        return x.to === 0
          ? `vanished for ${x.frames} frame${x.frames > 1 ? 's' : ''}, then came back`
          : `opacity flickered ${round(x.from, 2)} → ${round(x.to, 2)} and back within ${x.frames} frame${x.frames > 1 ? 's' : ''}`;
      case 'opacity-snap':
        return `opacity jumped ${round(x.from, 2)} → ${round(x.to, 2)} in one frame`;
      case 'swap':
        return `replaced ${x.from} in place with no crossfade`;
      case 'scroll-jump':
        return `scroll jumped ${px(n)} ${dirWord(x.axis || 'y', n)} in one frame`;
      case 'scroll-fight':
        return `scroll changed direction ${x.count} time${x.count > 1 ? 's' : ''} (±${px(n)}): two things scrolling it?`;
      case 'slow-frame':
        return `${x.count} slow frame${x.count > 1 ? 's' : ''}, longest ${Math.round(n)}ms${x.script ? ' in ' + x.script : ''}${
          x.forced
            ? `; ${Math.round(x.forced)}ms of it forced layout${x.forcedBy ? ` in ${x.forcedBy}` : ''} (layout read after a style change, often in a loop)`
            : ''
        }`;
      case 'slow-response':
        return `took ${Math.round(n)}ms to show any response to the ${x.input} (nothing moved, appeared, faded or changed text before then)`;
      case 'layout-anim':
        return `animates ${x.props.join(', ')}, which runs layout every frame`;
      default:
        return x.type;
    }
  }

  // What changed in the frame that pushed things: inserted, removed or resized elements.
  function causeAt(rec, f, S, sizeChanged, exclude) {
    const m = rec.mutations[f] || { added: [], moved: [], removed: [], text: [] };
    // Prefer an insertion that comes before something that moved: that's what pushed it.
    const movers = [...exclude];
    const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const added = m.added
      .map((el) => rec.trackOf.get(el))
      .filter(Boolean)
      .sort((a, b) => (before(a.el, b.el) ? -1 : 1));
    if (added.length) {
      const tr = added.find((a) => movers.some((mv) => !a.el.contains(mv.el) && before(a.el, mv.el))) || added[0];
      const s = S.get(tr);
      const h = s && s.h[f] != null ? ` (${Math.round(s.w[f])}×${Math.round(s.h[f])})` : '';
      return `${descOf(tr)} inserted${h}${added.length > 1 ? ` +${added.length - 1} more` : ''}`;
    }
    const removed = m.removed.map((el) => rec.trackOf.get(el)).filter(Boolean);
    if (removed.length) return `${descOf(removed[0])} removed`;
    const moved = m.moved.map((el) => rec.trackOf.get(el)).filter(Boolean);
    if (moved.length) return `${descOf(moved[0])} moved to a new parent`;
    const changed = sizeChanged[f].filter((t) => !exclude.has(t));
    const deepest = changed.filter((t) => !changed.some((o) => o !== t && t.el.contains(o.el)));
    if (deepest.length) {
      const tr = deepest[0];
      const s = S.get(tr);
      const dh = s.h[f] - s.h[f - 1];
      const dw = s.w[f] - s.w[f - 1];
      const textChanged = m.text.some((el) => tr.el.contains(el));
      const what =
        Math.abs(dh) >= Math.abs(dw)
          ? `got ${px(dh)} ${dh > 0 ? 'taller' : 'shorter'}`
          : `got ${px(dw)} ${dw > 0 ? 'wider' : 'narrower'}`;
      // A resize in the same frame is a likely cause, not a proven one.
      return { text: `${descOf(tr)} ${what}${textChanged ? ' (text changed)' : ''}`, sure: false };
    }
    return '';
  }

  function finalize(rec, raw, S, sizeChanged, T) {
    // Keep the outermost element when nested elements report the same thing in the same frame.
    const sameThing = (a, b) =>
      a.type === b.type && a.f === b.f && a.axis === b.axis && Math.abs((a.amount || 0) - (b.amount || 0)) <= 1;
    const kept = raw.filter(
      (x) => !x.tr || !raw.some((o) => o !== x && o.tr && o.tr.el !== x.tr.el && o.tr.el.contains(x.tr.el) && sameThing(o, x))
    );
    // Merge siblings doing the same thing at once ("li ×14 moved down 12px").
    const groups = new Map();
    let solo = 0;
    for (const x of kept) {
      // Elements that appear together because one subtree was inserted are one event,
      // reported as that subtree. Otherwise siblings (same parent and tag) doing the same
      // thing merge. `n` is the group size; `count` belongs to the finding.
      let inserted = null;
      if (x.tr && (x.type === 'pop-in' || x.type === 'flash')) {
        const m = rec.mutations[x.f] || rec.mutations[x.tr.born];
        // Inserted, or moved into place (streamed HTML is revealed by moving a hidden subtree).
        if (m) inserted = [...m.added, ...m.moved].find((a) => a !== x.tr.el && a.contains(x.tr.el)) || null;
      }
      const key = !x.tr
        ? `solo${solo++}`
        : inserted
          ? `${x.type}|${x.f}|in${idOf(inserted)}`
          : `${x.type}|${x.f}|${x.axis}|${Math.round(x.amount || 0)}|${x.tr.parent}|${x.tr.el.localName}`;
      const g = groups.get(key);
      if (g) g.n++;
      else groups.set(key, { ...x, n: 1, inserted });
    }
    const list = [...groups.values()].map((x) => {
      const sev = severity(x, T);
      const t = Math.round(rec.frames[x.f] || 0);
      let element = x.tr ? descOf(x.tr) : x.el ? describe(x.el) : x.scroller || x.target || 'page';
      if (x.inserted && x.n > 1) {
        element = `${describe(x.inserted)} (${x.n} elements)`;
        const r = x.inserted.getBoundingClientRect();
        if (x.inserted.isConnected && r.width) Object.assign(x, { w: r.width, h: r.height });
      } else if (x.n > 1) element += ` ×${x.n}`;
      const moving = new Set(kept.filter((k) => k.f === x.f && k.tr).map((k) => k.tr));
      const c = x.cause || (x.type === 'shift' || x.type === 'blip' ? causeAt(rec, x.f, S, sizeChanged, moving) : '');
      return {
        severity: sev,
        type: x.type,
        // Unanimated changes are facts, not necessarily defects: instant is a valid choice.
        group: UNANIMATED.has(x.type) ? 'unanimated' : 'defect',
        t,
        frame: x.f,
        element,
        message: message(x),
        cause: typeof c === 'string' ? c : c.text,
        causeSure: typeof c === 'string' ? !!c : c.sure,
        animation: x.animation || (x.tr && MOTION.has(x.type) ? animFor(rec, x.tr.el, x.f, x.type) : '') || undefined,
        amount: x.amount != null ? round(x.amount, 1) : undefined,
      };
    });
    list.sort((a, b) => (a.group === b.group ? 0 : a.group === 'defect' ? -1 : 1) || SEV[b.severity] - SEV[a.severity] || a.t - b.t);
    return list;
  }

  // ---------- expectations ----------

  // One track per element: a node removed and put back has several, joined here with a
  // blank gap (not rendered) between them.
  function stitch(trs) {
    if (trs.length === 1) return trs[0];
    trs = trs.slice().sort((a, b) => a.born - b.born);
    const rows = [];
    trs.forEach((t, i) => {
      rows.push(...t.rows);
      if (i < trs.length - 1 && t.died !== null) rows.push([t.died, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
    });
    rows.sort((a, b) => a[F_] - b[F_]);
    const lastT = trs[trs.length - 1];
    return { ...lastT, born: trs[0].born, died: lastT.died, rows, last: rows[rows.length - 1] };
  }

  function matching(rec, sel) {
    const byEl = new Map();
    for (const tr of rec.tracks.values()) {
      try {
        if (!tr.el.matches(sel)) continue;
      } catch (_) {
        return [];
      }
      if (!byEl.has(tr.el)) byEl.set(tr.el, []);
      byEl.get(tr.el).push(tr);
    }
    const out = [...byEl.values()].map(stitch);
    return out.filter((t) => !out.some((o) => o.el !== t.el && o.el.contains(t.el)));
  }
  const firstLast = (xs) => {
    let a = null;
    let b = null;
    for (const v of xs) if (v != null) {
      if (a === null) a = v;
      b = v;
    }
    return [a, b];
  };

  // Per-frame values for "whatever matches sel": when a framework remounts an element, the
  // expectation follows the copy that is on screen (the newest one when both are).
  function follow(rec, sel, get) {
    const all = [];
    for (const tr of rec.tracks.values()) {
      try {
        if (tr.el.matches(sel)) all.push(tr);
      } catch (_) {
        return null;
      }
    }
    const trs = all.filter((t) => !all.some((o) => o.el !== t.el && o.el.contains(t.el))).sort((a, b) => b.born - a.born);
    if (!trs.length) return null;
    const F = rec.frames.length;
    const out = { vx: [], vy: [], o: [], a: [], rendered: [], trs };
    const ss = trs.map(get);
    for (let f = 0; f < F; f++) {
      let k = ss.findIndex((s) => s.rendered[f] && s.o[f] >= 0.05 && s.a[f] > 0);
      if (k < 0) k = ss.findIndex((s) => s.rendered[f]);
      const s = k >= 0 ? ss[k] : null;
      out.vx.push(s ? s.vx[f] : null);
      out.vy.push(s ? s.vy[f] : null);
      out.o.push(s ? s.o[f] : 0);
      out.a.push(s ? s.a[f] : 0);
      out.rendered.push(!!s);
    }
    return out;
  }

  function check(rec, spec, S, findings) {
    S = S || new Map();
    const get = (tr) => S.get(tr) || (S.set(tr, series(rec, tr)), S.get(tr));
    const out = [];
    const claimed = [];
    const tol = spec.tolerance != null ? spec.tolerance : 2;
    for (const [sel, want] of Object.entries(spec.moves || {})) {
      const s = follow(rec, sel, get);
      if (!s) {
        out.push({ name: `moves ${sel}`, pass: false, detail: 'no element matched' });
        continue;
      }
      claimed.push(...s.trs);
      const [x0, x1] = firstLast(s.vx);
      const [y0, y1] = firstLast(s.vy);
      const got = { dx: round(x1 - x0, 1), dy: round(y1 - y0, 1) };
      const t2 = want.tolerance != null ? want.tolerance : tol;
      const pass = ['dx', 'dy'].every((k) => want[k] == null || Math.abs(got[k] - want[k]) <= t2);
      out.push({ name: `moves ${sel}`, pass, detail: `dx ${got.dx}, dy ${got.dy} (wanted ${want.dx != null ? 'dx ' + want.dx + ' ' : ''}${want.dy != null ? 'dy ' + want.dy : ''} ±${t2})` });
    }
    const fade = (sels, dir) => {
      for (const sel of [].concat(sels || [])) {
        const s = follow(rec, sel, get);
        if (!s) {
          out.push({ name: `${dir} ${sel}`, pass: false, detail: 'no element matched' });
          continue;
        }
        claimed.push(...s.trs);
        const vis = s.o.map((o, f) => s.rendered[f] && o >= 0.05 && s.a[f] > 0);
        const first = vis.indexOf(true);
        const lastF = vis.lastIndexOf(true);
        let pass;
        let detail;
        if (first < 0) {
          pass = false;
          detail = 'never visible';
        } else if (dir === 'fadesIn') {
          pass = s.o[first] < 0.5 && s.o[lastF] >= 0.9;
          detail = `opacity ${round(s.o[first], 2)} on its first visible frame, ${round(s.o[lastF], 2)} at the end`;
        } else {
          pass = s.o[lastF] < 0.5;
          detail = `opacity ${round(s.o[lastF], 2)} on its last visible frame`;
        }
        out.push({ name: `${dir} ${sel}`, pass, detail });
      }
    };
    fade(spec.fadesIn, 'fadesIn');
    fade(spec.fadesOut, 'fadesOut');
    if (spec.still) {
      const max = spec.maxShift != null ? spec.maxShift : 1;
      let trs;
      if (spec.still === 'others') {
        trs = [...rec.tracks.values()].filter(
          (t) =>
            !t.skip &&
            !(rec.loops && rec.loops.has(t)) &&
            t.paints &&
            t.born === firstFrameOf(rec) &&
            t.died === null &&
            !claimed.some((c) => c.el.contains(t.el) || t.el.contains(c.el))
        );
      } else {
        const sels = [].concat(spec.still);
        const missing = sels.filter((sel) => !matching(rec, sel).length);
        if (missing.length) {
          out.push({ name: `still ${sels.join(', ')}`, pass: false, detail: `no element matched ${missing.join(', ')}` });
          trs = null;
        } else trs = sels.flatMap((sel) => matching(rec, sel));
      }
      const movers = [];
      for (const tr of trs || []) {
        if (tr.rows.length < 2) continue;
        const s = get(tr);
        if (!s.a.some((a) => a > 0)) continue;
        let worst = 0;
        for (const axis of ['x', 'y']) {
          const v = axis === 'x' ? s.vx : s.vy;
          const c = axis === 'x' ? s.cx : s.cy;
          const xs = pathLength(c) <= pathLength(v) ? c : v;
          const [x0] = firstLast(xs);
          for (const val of xs) if (val != null) worst = Math.max(worst, Math.abs(val - x0));
        }
        if (worst > max) movers.push({ tr, worst });
      }
      const top = movers.filter((m) => !movers.some((o) => o !== m && o.tr.el !== m.tr.el && o.tr.el.contains(m.tr.el)));
      if (trs) out.push({
        name: `still ${spec.still === 'others' ? 'others' : [].concat(spec.still).join(', ')}`,
        pass: top.length === 0,
        detail: top.length
          ? `${top.length} moved more than ${max}px: ` + top.slice(0, 3).map((m) => `${descOf(m.tr)} ${px(m.worst)}`).join('; ')
          : `nothing moved more than ${max}px`,
        // The same, structured, for the report and for code reading the JSON.
        summary: top.length ? `${top.length} moved more than ${max}px` : undefined,
        moved: top.length ? top.slice(0, 3).map((m) => ({ element: descOf(m.tr), px: round(m.worst, 1) })) : undefined,
        more: top.length > 3 ? top.length - 3 : undefined,
      });
    }
    if (spec.noFindings) {
      const floor = SEV[spec.noFindings] || 2;
      const bad = (findings || (rec.result && rec.result.findings) || []).filter((x) => SEV[x.severity] >= floor);
      out.push({ name: `no ${spec.noFindings}+ findings`, pass: bad.length === 0, detail: bad.length ? `${bad.length} found` : 'none' });
    }
    return out;
  }

  // ---------- report ----------

  // The text report: one block per finding, under 72 columns so it reads the same in a
  // narrow terminal, a CI log or a README. Plain text: agents read it through browser
  // tools, and the runner adds colour only when it prints to a terminal.
  const WIDTH = 72;
  const COL = 16; // where a finding's details start: "HIGH    +10ms   "
  // The runner's --matrix summary (run.mjs) uses the same width and column.
  // Words in parentheses stay together, "(moving ~5.6px/frame)", so wrapping never splits
  // a value; anything longer than a line is broken at the edge.
  function words(text) {
    const out = [];
    let depth = 0;
    for (const w of String(text).split(/\s+/)) {
      if (!w) continue;
      if (depth > 0) out[out.length - 1] += ' ' + w;
      else out.push(w);
      for (const ch of w) depth = Math.max(0, depth + (ch === '(' ? 1 : ch === ')' ? -1 : 0));
    }
    return out;
  }
  function wrap(prefix, text, indent) {
    const out = [];
    let cur = prefix;
    let fresh = true; // nothing after the prefix yet, so the next word joins it whatever its length
    const newLine = () => {
      out.push(cur.trimEnd());
      cur = ' '.repeat(indent);
      fresh = true;
    };
    for (let w of words(text)) {
      if (!fresh && cur.length + 1 + w.length > WIDTH) newLine();
      while (cur.length + (fresh ? 0 : 1) + w.length > WIDTH) {
        const room = WIDTH - cur.length - (fresh ? 0 : 1);
        if (room < 8) break;
        cur += (fresh ? '' : ' ') + w.slice(0, room);
        w = w.slice(room);
        newLine();
      }
      cur += (fresh ? '' : ' ') + w;
      fresh = false;
    }
    out.push(cur.trimEnd());
    return out;
  }

  function block(x) {
    const pad = ' '.repeat(COL);
    const lines = wrap(`${x.severity.toUpperCase().padEnd(8)}${('+' + x.t + 'ms').padEnd(7)} `, x.element, COL);
    lines.push(...wrap(pad, x.message, COL));
    if (x.cause) lines.push(...wrap(pad, `${x.causeSure === false ? 'same frame' : 'cause'}: ${x.cause}`, COL + 2));
    if (x.animation) lines.push(...wrap(pad, `animation: ${x.animation}`, COL + 2));
    return lines;
  }

  function report(result, opts) {
    const r = result || (last && last.result);
    if (!r) return 'antijank: nothing recorded yet';
    const maxLines = (opts && opts.maxLines) || (last && last.opts.maxLines) || DEFAULTS.maxLines;
    const when =
      r.status === 'settled' ? `settled in ${r.duration}ms` : r.status === 'timeout' ? `did not settle in ${r.duration}ms` : r.status;
    const facts = [`antijank ${r.version}`, when];
    if (r.frames != null) facts.push(`${r.frames} frames`, `${r.elements} elements`);
    const head = [facts.join(' · ')];
    const note = (text) => head.push(...wrap('note: ', text, 6));
    if (r.truncated) note(`${r.truncated} elements were not watched (over maxElements), so findings may be missing. Narrow \`root\`.`);
    if (r.loops && r.loops.length) note(`left out as continuous loops: ${r.loops.join('; ')}`);
    if (r.viewTransition) {
      const n = r.viewTransition.leftOut;
      note(
        `a View Transition ran +${r.viewTransition.from}–${r.viewTransition.to}ms. It animates snapshots the probe can't see, so ${n} element finding${n === 1 ? '' : 's'} from that window ${n === 1 ? 'was' : 'were'} left out.`
      );
    }
    if (r.stallJumps)
      note(`left out ${r.stallJumps} jump${r.stallJumps > 1 ? 's' : ''} after a slow frame on compositor animations, which keep moving on screen while the main thread is busy`);
    if (r.stillChanging && r.stillChanging.length)
      note(`still changing at the end: ${r.stillChanging.join('; ')}. Raise timeout, pass waitFor, or ignore them.`);
    if (r.status === 'hidden') note('the page is hidden, so the browser pauses frames. Show the tab or pane and record again.');
    if (r.probeMs && r.probeMs.avg > 4) note(`the probe took ${r.probeMs.avg}ms per frame; narrow \`root\` so it doesn't disturb timing`);
    // A stack trace is for the JSON; the report keeps its first line.
    if (r.error) head.push(...wrap('error: ', String(r.error).split('\n')[0], 7));

    const sections = [head];
    const fs = r.findings || [];
    if (!fs.length && r.status !== 'hidden' && !r.error) sections.push(['no jank found']);
    const defects = fs.filter((x) => x.group !== 'unanimated').slice(0, maxLines);
    const unanimated = fs.filter((x) => x.group === 'unanimated').slice(0, Math.max(3, maxLines - defects.length));
    if (defects.length) sections.push(defects.flatMap(block));
    if (unanimated.length) sections.push(['Unanimated, fine if instant is intended (tabs, menus, keys)', ...unanimated.flatMap(block)]);
    const moreD = fs.filter((x) => x.group !== 'unanimated').length - defects.length;
    const moreU = fs.filter((x) => x.group === 'unanimated').length - unanimated.length;
    if (moreD + moreU > 0) {
      const parts = [moreD ? `${moreD} defect${moreD > 1 ? 's' : ''}` : '', moreU ? `${moreU} unanimated` : ''].filter(Boolean);
      sections.push(wrap('', `+${parts.join(' and ')} more in antijank.result().findings`, 0));
    }
    const ex = r.expectations || [];
    if (ex.length)
      sections.push([
        'Expectations',
        ...ex.flatMap((e) => [
          ...wrap(`${e.pass ? '✓' : '✗'} `, `${e.name}: ${e.summary || e.detail}`, 2),
          ...(e.moved && e.moved.length
            ? wrap('  ', [...e.moved.map((m) => `${m.element} ${px(m.px)}`), ...(e.more ? [`+${e.more} more`] : [])].join(', '), 2)
            : []),
        ]),
      ]);
    return sections.map((x) => x.join('\n')).join('\n\n');
  }

  // ---------- public API ----------

  function stop() {
    if (current) finish(current, 'stopped');
    return last && last.result;
  }

  // Holds settling until the action has finished, so a multi-step action is recorded whole.
  async function record(action, opts) {
    const done = start({ ...(opts || {}), hold: true });
    const rec = current;
    if (rec) rec.synthetic = true; // the action's own el.click() is the interaction
    try {
      if (typeof action === 'function') await action();
    } finally {
      if (rec) rec.synthetic = false;
      release();
    }
    return done;
  }

  function timeline(sel, all) {
    if (!last) return [];
    const trs = matching(last, sel);
    if (all) return trs.map((tr) => ({ element: descOf(tr), born: tr.born, died: tr.died, frames: frameRows(tr) }));
    return trs[0] ? frameRows(trs[0]) : [];
  }
  function frameRows(tr) {
    const s = series(last, tr);
    return last.frames.map((t, f) => ({
      f,
      t: Math.round(t),
      x: s.vx[f] == null ? null : round(s.vx[f], 1),
      y: s.vy[f] == null ? null : round(s.vy[f], 1),
      w: s.w[f] == null ? null : round(s.w[f], 1),
      h: s.h[f] == null ? null : round(s.h[f], 1),
      opacity: round(s.o[f], 3),
      visibleArea: Math.round(s.a[f]),
    }));
  }

  window.antijank = {
    version: VERSION,
    start,
    stop,
    release,
    wait,
    record,
    report,
    timeline,
    result: () => last && last.result,
    expect: (spec) => (last ? check(last, spec, null, last.result && last.result.findings) : []),
    get recording() {
      return !!current;
    },
    thresholds: THRESHOLDS,
    // Internal state of the last recording, for debugging the probe itself.
    _debug: () => last,
  };

  // Recording from page load: the runner sets this before the page's own scripts run.
  const auto = window.__antijankAutostart;
  if (auto) {
    window.__antijankAutostart = null;
    start(auto);
  }
})();
