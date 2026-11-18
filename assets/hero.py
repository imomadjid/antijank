# Draws assets/hero-light.svg and assets/hero-dark.svg. Run from the repo root: python3 assets/hero.py
# The positions and the report lines are copied from a recording of fixtures/blip-mid-move.html:
#   node skills/antijank/scripts/run.mjs fixtures/blip-mid-move.html --steps '[{"record":[{"eval":"trigger()"}]}]'
# Update them here when that output changes.
def svg(dark):
    c = dict(
        bg='#0d1117' if dark else '#ffffff',
        panel='#161b22' if dark else '#f6f8fa',
        line='#30363d' if dark else '#d0d7de',
        muted='#8b949e' if dark else '#57606a',
        text='#e6edf3' if dark else '#1f2328',
        card='#4c8dff' if dark else '#3b6fe0',
        bar='#2d333b' if dark else '#e3e8ee',
        bad='#ff7b72' if dark else '#cf222e',
    )
    W, H = 960, 452
    sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
    mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="Seven frames of a card sliding down. In frame 4 it lands 38px below its path for one frame, then snaps back. antijank reports it as a HIGH blip.">',
         f'<rect x="0.5" y="0.5" width="{W-1}" height="{H-1}" rx="16" fill="{c["bg"]}" stroke="{c["line"]}"/>',
         f'<text x="48" y="58" font-family="{sans}" font-size="15" font-weight="600" fill="{c["text"]}">A card slides down and lands 38px off its path for one frame.</text>',
         f'<text x="48" y="82" font-family="{sans}" font-size="13" fill="{c["muted"]}">Too short for a screenshot to catch. antijank reads it from the numbers.</text>',
         f'<text x="{W-48}" y="82" text-anchor="end" font-family="{mono}" font-size="12" fill="{c["muted"]}">frames 1–7 of 31</text>']
    tw, th, gap, x0, y0 = 112, 168, 12, 48, 108
    # card y per frame (inside tile); frame index 3 is the blip
    # The recorded positions (px): 0, 12, 24, then 68 for one frame where 30 was due, 36, 44, 48.
    rec = [0, 12, 24, 68, 36, 44, 48]
    ys = [26 + v * 0.95 for v in rec]
    expect = [26 + v * 0.95 for v in [0, 12, 24, 30, 36, 44, 48]]
    for i in range(7):
        x = x0 + i * (tw + gap)
        bad = i == 3
        o.append(f'<rect x="{x}" y="{y0}" width="{tw}" height="{th}" rx="10" fill="{c["panel"]}" stroke="{c["bad"] if bad else c["line"]}" stroke-width="{2 if bad else 1}"/>')
        o.append(f'<rect x="{x+12}" y="{y0+12}" width="{tw-24}" height="6" rx="3" fill="{c["bar"]}"/>')
        if bad:
            o.append(f'<rect x="{x+16}" y="{y0+expect[i]}" width="{tw-32}" height="40" rx="6" fill="none" stroke="{c["muted"]}" stroke-dasharray="4 3"/>')
            o.append(f'<text x="{x+tw/2}" y="{y0+expect[i]+24}" text-anchor="middle" font-family="{sans}" font-size="11" fill="{c["muted"]}">expected</text>')
        o.append(f'<rect x="{x+16}" y="{y0+ys[i]}" width="{tw-32}" height="40" rx="6" fill="{c["bad"] if bad else c["card"]}" opacity="{1 if bad else 0.9}"/>')
        o.append(f'<text x="{x+tw/2}" y="{y0+th+22}" text-anchor="middle" font-family="{mono}" font-size="12" fill="{c["bad"] if bad else c["muted"]}">frame {i+1}</text>')
    ry = y0 + th + 48
    o.append(f'<rect x="48" y="{ry}" width="{W-96}" height="80" rx="10" fill="{c["panel"]}" stroke="{c["line"]}"/>')
    lines = [
        (c['muted'], 'antijank 0.1.0 · settled after 480ms · 31 frames · 4 elements · probe 0.26ms/frame'),
        (c['bad'], 'HIGH   +47ms    div#card — was 38px down of its place for 1 frame, then snapped back'),
    ]
    for k, (col, t) in enumerate(lines):
        t = t.replace('&', '&amp;').replace('<', '&lt;')
        o.append(f'<text x="68" y="{ry+30+k*24}" font-family="{mono}" font-size="13" fill="{col}" xml:space="preserve">{t}</text>')
    o.append('</svg>')
    return '\n'.join(o) + '\n'
open('assets/hero-light.svg', 'w').write(svg(False))
open('assets/hero-dark.svg', 'w').write(svg(True))
