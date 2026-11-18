// Small helpers shared by the fixture pages.
window.frame = () => new Promise((r) => requestAnimationFrame(() => r()));
window.frames = async (n) => {
  for (let i = 0; i < n; i++) await frame();
};
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
window.tween = (ms, fn, ease = easeOut) =>
  new Promise((res) => {
    let t0 = null;
    const step = (now) => {
      if (t0 === null) t0 = now;
      const p = Math.min(1, (now - t0) / ms);
      fn(ease(p));
      p < 1 ? requestAnimationFrame(step) : res();
    };
    requestAnimationFrame(step);
  });
// A damped spring driven by requestAnimationFrame; damping 14 overshoots about 13%.
window.spring = (from, to, fn, { stiffness = 170, damping = 14 } = {}) =>
  new Promise((res) => {
    let x = from;
    let v = 0;
    let last = null;
    const step = (now) => {
      const dt = last === null ? 1 / 60 : Math.min(32, now - last) / 1000;
      last = now;
      v += (-stiffness * (x - to) - damping * v) * dt;
      x += v * dt;
      fn(x);
      if (Math.abs(v) < 1 && Math.abs(x - to) < 0.2) {
        fn(to);
        res();
      } else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
