# README artwork

The illustration is original artwork rendered with Python. Its typography uses Instrument Sans by the Instrument Sans Project Authors, licensed under the SIL Open Font License. Glyph outlines and the font license are bundled in `ci/docs/fonts/`. The original layout and generator are covered by this repository's MIT license; the font and derived glyph outlines retain their OFL license.

## Regenerate

From a complete source checkout, with Python 3:

```sh
python3 ci/docs/render-overview.py
python3 ci/docs/render-overview.py --check
```

The regular renderer uses only Python's standard library and reads bundled glyph outlines. It performs no network requests. Lettering is stored as reusable SVG paths, so the intended typeface appears consistently on GitHub and offline without loading a web font.

The SVG has a fixed 1600 × 1000 viewBox and accessible title, description and text labels. CI checks exact regeneration, a bounded file size and local fragment references. Scripts and external resources are prohibited.

To rebuild the glyph outlines after deliberately changing the font or its supported character set, use the optional maintainer tool with `fonttools==4.67.0` installed:

```sh
python3 ci/docs/build-font-outlines.py --font /path/to/InstrumentSans.ttf
python3 ci/docs/render-overview.py
```

Ordinary users and CI do not need fonttools. The font source is from the Google Fonts `ofl/instrumentsans` directory; the bundled original license records its copyright and redistribution terms.

The README uses an absolute raw GitHub asset URL for GitHub and npm portability. Artwork, font files and generation tools are repository-only and are not included in the extension's npm runtime payload.
