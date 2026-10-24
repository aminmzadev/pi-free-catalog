#!/usr/bin/env python3
"""Optional maintainer tool: rebuild bundled glyph data with fonttools 4.67.0.
The regular illustration renderer uses only Python's standard library.
Instrument Sans is licensed under SIL OFL; see fonts/OFL.txt.
"""
from pathlib import Path
import json
import argparse
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--font', type=Path, required=True, help='Path to the original Instrument Sans variable TTF')
args = parser.parse_args()
result = {}
for weight in (450, 600, 700):
    font = instantiateVariableFont(TTFont(args.font), {'wght': weight, 'wdth': 100}, inplace=True)
    glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
    rows = {}
    for code in [*range(32, 127), 183]:
        glyph = glyphs[cmap[code]]
        pen = SVGPathPen(glyphs, ntos=lambda n: format(round(n, 2), 'g'))
        glyph.draw(pen)
        rows[str(code)] = {'width': glyph.width, 'path': pen.getCommands()}
    result[str(weight)] = {'unitsPerEm': font['head'].unitsPerEm, 'glyphs': rows}
(HERE / 'fonts/outlines.json').write_text(json.dumps(result, ensure_ascii=True, sort_keys=True, separators=(',', ':')) + '\n')
