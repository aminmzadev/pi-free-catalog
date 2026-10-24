#!/usr/bin/env python3
"""Render the README artwork with Python standard library only.
Instrument Sans glyph outlines are bundled under SIL OFL in fonts/.
Bundled glyph outlines keep the intended typography on GitHub and offline.
"""
from pathlib import Path
from html import escape
import sys
import hashlib
import json

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'docs/assets/catalog-overview.svg'
OUTLINES = Path(__file__).parent / 'fonts/outlines.json'
INK = '#213b31'
MUTED = '#4f6257'


def render():
    fonts = json.loads(OUTLINES.read_text())
    parts = ['''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1600" height="1000" viewBox="0 0 1600 1000" role="img" aria-labelledby="title description">
<title id="title">Free AI models, right inside Pi</title>
<desc id="description">Public model metadata is validated and published as a GitHub Pages snapshot for Pi's local catalog. Inference requests go to the active provider rather than the catalog host. Reviewed Free Pools are opt-in and support model selection, per-model thinking settings and scheduling.</desc>
<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6" fill="none" stroke="#416653" stroke-width="1.5"/></marker></defs>
<rect width="1600" height="1000" rx="24" fill="#f4f2eb"/>
''']

    # Exact visible vector bounds, including glyph ink and outer card strokes.
    # The background is excluded; center the composition, not the 1600x1000 frame.
    content_bounds = (79.375, 98.842, 1520.625, 976.73)
    dx = 800 - (content_bounds[0] + content_bounds[2]) / 2
    dy = 500 - (content_bounds[1] + content_bounds[3]) / 2
    parts.append(f'<g id="composition" transform="translate({dx:.6f} {dy:.6f})">')

    defined = set()

    def text(x, y, value, size=24, weight=450, color=INK, maxwidth=None):
        font = fonts[str(weight)]
        glyphs = font['glyphs']
        scale = size / font['unitsPerEm']
        advance = sum(glyphs[str(ord(ch))]['width'] for ch in value)
        assert maxwidth is None or advance * scale <= maxwidth, (value, advance * scale, maxwidth)
        paths = []
        cursor = 0
        for ch in value:
            glyph = glyphs[str(ord(ch))]
            key = f'g{weight}_{ord(ch)}'
            if key not in defined:
                parts.append(f'<defs><path id="{key}" d="{glyph["path"]}"/></defs>')
                defined.add(key)
            paths.append(f'<use xlink:href="#{key}" x="{cursor}"/>')
            cursor += glyph['width']
        parts.append(f'<g fill="{color}" role="img" aria-label="{escape(value, quote=True)}"><title>{escape(value)}</title><g transform="translate({x} {y}) scale({scale:.8f} {-scale:.8f})">'+''.join(paths)+'</g></g>')

    text(80, 112, 'A PI CODING AGENT EXTENSION', 18, 600, MUTED, 375)
    text(75, 215, 'Free models.', 90, 600, maxwidth=920)
    text(75, 311, 'Right inside Pi.', 90, 600, maxwidth=1000)
    text(80, 371, 'Explore models. Review capabilities. Build your Free Pool.', 31, 450, MUTED, 1100)

    parts.append('<path d="M1145 164V340" stroke="#cdd4c9"/>')
    text(1180, 179, 'PROVIDERS', 18, 600, MUTED)
    text(1180, 224, 'Kilo', 32, 600)
    text(1180, 272, 'OpenCode Zen', 32, 600)
    text(1180, 320, 'OVHcloud', 32, 600)

    cards = [
        (80, '01', 'Public model feeds', ['Pricing & access evidence', 'Tool & thinking support', 'Lifecycle & retirement'], 'Kilo · Zen · OVHcloud'),
        (574, '02', 'Validated catalog', ['Schema & integrity checks', 'Published on GitHub Pages', 'Per-source freshness'], 'Metadata only'),
        (1068, '03', 'Ready in Pi', ['Saved model catalog', 'Refresh at startup and manually', 'Free Pools you can enable'], 'Choose models and settings'),
    ]
    for x, num, title, rows, footer in cards:
        # Flat vector depth and a consistent top rail remain portable on GitHub.
        parts.append(f'<rect x="{x}" y="435" width="452" height="322" rx="18" fill="#dfe5d9" opacity="0.52"/>')
        parts.append(f'<rect x="{x}" y="430" width="452" height="322" rx="18" fill="#fcfbf7" stroke="#c5d0c0" stroke-width="1.25"/>')
        parts.append(f'<rect x="{x+28}" y="452" width="44" height="29" rx="8" fill="#e5ecdf"/>')
        text(x+39, 473, num, 18, 600, '#416653')
        # Decorative, locally drawn icons introduce no resources or font dependencies.
        parts.append(f'<g transform="translate({x+394} 450)" fill="none" stroke="#59755e" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">')
        if num == '01':
            parts.append('<rect x="0" y="2" width="28" height="9" rx="2.5"/><rect x="0" y="17" width="28" height="9" rx="2.5"/><path d="M5 6.5h1m4 0h12M5 21.5h1m4 0h12"/>')
        elif num == '02':
            parts.append('<path d="M14 0L27 5v9c0 8-7 13-13 16C8 27 1 22 1 14V5Z"/><path d="M7.5 14.5l4.5 4.5 9-10"/>')
        else:
            parts.append('<rect x="0" y="1" width="29" height="26" rx="4"/><path d="M0 8h29M6 14l4 4-4 4m9 0h7"/>')
        parts.append('</g>')
        text(x+28, 526, title, 33, 600, maxwidth=396)
        for i, row in enumerate(rows):
            text(x+28, 575+i*40, row, 26, 450, MUTED, 396)
        parts.append(f'<path d="M{x+28} 691H{x+424}" stroke="#d8dfd1" stroke-width="1.25"/>')
        text(x+28, 729, footer, 23, 600, maxwidth=396)
    for cx in (553, 1047):
        parts.append(f'<g aria-hidden="true"><path d="M{cx-8} 592H{cx+8}m-6-6 6 6-6 6" fill="none" stroke="#416653" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></g>')

    parts.append('<rect x="80" y="786" width="1440" height="144" rx="18" fill="#213b31"/>')
    text(112, 825, 'DIRECT REQUESTS TO THE ACTIVE PROVIDER', 19, 600, '#c4dfc4', 690)
    text(112, 884, 'Pi', 40, 600, '#fbfcf6')
    parts.append('<path d="M180 871H244m-9-8 9 8-9 8" fill="none" stroke="#c4dfc4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>')
    text(267, 884, 'Active provider', 38, 600, '#fbfcf6', 525)
    parts.append('<path d="M820 816V899" stroke="#597361" stroke-width="1.25"/>')
    text(858, 845, 'Model requests go to the active provider.', 26, 450, '#fbfcf6', 630)
    text(858, 886, 'GitHub Pages serves catalog metadata only.', 26, 450, '#c4dfc4', 630)
    # Match the three card-column centers and use one shared footer baseline.
    footer_labels = ['Model-native thinking', 'Your choice of models', 'Flexible pool scheduling']
    footer_font = fonts['600']
    # Correct advance-width centering for the actual visible glyph bearings.
    ink_corrections = (0.055, 0.04037, 0.055)
    for center, label, correction in zip((306, 800, 1294), footer_labels, ink_corrections):
        width = sum(footer_font['glyphs'][str(ord(ch))]['width'] for ch in label) * 22 / footer_font['unitsPerEm']
        text(center-width/2+correction, 972, label, 22, 600, MUTED, 396)
    parts.append('</g></svg>\n')
    return '\n'.join(parts)


if __name__ == '__main__':
    data = render().encode()
    if '--check' in sys.argv:
        if not OUTPUT.exists() or OUTPUT.read_bytes() != data:
            raise SystemExit('Illustration differs: run python3 ci/docs/render-overview.py')
        print('Illustration reproducibility: PASS')
    else:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_bytes(data)
        print(f'Wrote {OUTPUT.relative_to(ROOT)} ({len(data)} bytes)')
    print('SHA256 ' + hashlib.sha256(data).hexdigest())
