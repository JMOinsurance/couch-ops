#!/usr/bin/env python3
"""Generates the iPhone/Android home-screen icons from the real Redefined
Couches product photo (logo-source.jpg — a square shot of the grey sectional
with "REDEFINED COUCHES" branding baked in).

Replaces the earlier hand-drawn couch-silhouette icon (generate-icons.js) now
that we have a real branded photo to use instead. Needs Pillow (PIL) since
Node has no built-in image resizer:

    pip install pillow --break-system-packages
    python3 scripts/generate-icons.py

Writes into public/icons/ (this app) — for the showroom site's own icons/
folder, run this same script there with its own copy of logo-source.jpg, or
just copy the output PNGs over (source photo is identical for both sites).
"""

import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, '..', 'public', 'logo-source.jpg')
OUT_DIR = os.path.join(HERE, '..', 'public', 'icons')

SIZES = {
    'icon-512.png': 512,
    'icon-192.png': 192,
    'apple-touch-icon-180.png': 180,
    'favicon-32.png': 32,
}

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    src = Image.open(SOURCE).convert('RGB')
    for name, size in SIZES.items():
        resized = src.resize((size, size), Image.LANCZOS)
        out_path = os.path.join(OUT_DIR, name)
        resized.save(out_path, 'PNG')
        print(f'Wrote public/icons/{name} ({size}x{size})')

if __name__ == '__main__':
    main()
