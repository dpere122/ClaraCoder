"""
Raster Clara Coder app icons from the graphite open-loop mark.

The mark is drawn from the same geometry as `assets/clara-logo-graphite.svg` (64-unit tile),
supersampled per output size so 16–32px icons stay crisp. OS / taskbar icons sit on the
filled rounded tile; the etch asset is the white silhouette used as a CSS mask.

Run from repo root:
  python scripts/render_clara_coder_icon.py
  npm run render:icon
"""

from __future__ import annotations

import io
import math
import struct
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("Install Pillow: pip install Pillow", file=sys.stderr)
    sys.exit(1)

HICOLOR_SIZES = (16, 24, 32, 48, 64, 96, 128, 256, 512, 1024)
FAVICON_SIZES = (16, 32, 48)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)

# Palette (keep in sync with assets/clara-logo-graphite.svg).
PLATE = (15, 15, 17, 255)  # #0f0f11
RING = (58, 58, 66, 255)  # #3a3a42
GLYPH = (244, 244, 245, 255)  # #f4f4f5
PROMPT = (77, 163, 255, 255)  # #4da3ff
WHITE = (255, 255, 255, 255)

# Geometry in 64-unit tile coordinates.
TILE = 64.0
TILE_RADIUS = 14.0
CENTER = (33.0, 32.0)
OUTER = (22.0, 6.0, 40.0)  # radius, stroke width, half-opening (degrees)
INNER = (12.0, 5.0, 50.0)
CHEVRON = (((47.5, 28.0), (51.5, 32.0), (47.5, 36.0)), 2.8)

ETCH_FILL = 0.92


def supersample_for(size: int) -> int:
    return 8 if size <= 64 else 4


def draw_open_arc(
    draw: ImageDraw.ImageDraw,
    scale: float,
    radius: float,
    width: float,
    half_open: float,
    fill: tuple[int, int, int, int],
) -> None:
    """Round-capped arc around CENTER with its opening facing right (PIL angles run clockwise)."""
    cx, cy = CENTER
    outer = radius + width / 2
    box = [(cx - outer) * scale, (cy - outer) * scale, (cx + outer) * scale, (cy + outer) * scale]
    draw.arc(box, start=half_open, end=360 - half_open, fill=fill, width=max(1, round(width * scale)))
    for angle in (half_open, -half_open):
        ex = cx + radius * math.cos(math.radians(angle))
        ey = cy + radius * math.sin(math.radians(angle))
        draw_dot(draw, scale, (ex, ey), width / 2, fill)


def draw_dot(
    draw: ImageDraw.ImageDraw,
    scale: float,
    center: tuple[float, float],
    radius: float,
    fill: tuple[int, int, int, int],
) -> None:
    x, y = center
    draw.ellipse(
        [(x - radius) * scale, (y - radius) * scale, (x + radius) * scale, (y + radius) * scale],
        fill=fill,
    )


def draw_mark(draw: ImageDraw.ImageDraw, scale: float, colors: tuple[tuple[int, int, int, int], ...]) -> None:
    ring, glyph, prompt = colors
    draw_open_arc(draw, scale, *OUTER, ring)
    draw_open_arc(draw, scale, *INNER, glyph)
    points, width = CHEVRON
    draw.line([(x * scale, y * scale) for x, y in points], fill=prompt, width=max(1, round(width * scale)), joint="curve")
    for point in points:
        draw_dot(draw, scale, point, width / 2, prompt)


def tiled_icon(size: int) -> Image.Image:
    ss = supersample_for(size)
    big = size * ss
    scale = big / TILE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=TILE_RADIUS * scale, fill=PLATE)
    draw_mark(draw, scale, (RING, GLYPH, PROMPT))
    return img.resize((size, size), Image.Resampling.LANCZOS)


def etch_icon(size: int) -> Image.Image:
    """White silhouette of the mark (no plate), fitted to ETCH_FILL of the canvas."""
    ss = supersample_for(size)
    big = size * ss
    mark = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw_mark(ImageDraw.Draw(mark), big / TILE, (WHITE, WHITE, WHITE))
    mark = mark.crop(mark.getbbox())
    target = int(round(big * ETCH_FILL))
    mark.thumbnail((target, target), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    canvas.paste(mark, ((big - mark.width) // 2, (big - mark.height) // 2), mark)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def write_png_ico(path: Path, images: list[Image.Image]) -> None:
    """Write a PNG-in-ICO with one pre-rendered bitmap per size (no upscaling)."""
    ordered = sorted(images, key=lambda im: im.size[0])
    blobs = []
    for im in ordered:
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        blobs.append((im.size[0], im.size[1], buf.getvalue()))
    offset = 6 + 16 * len(blobs)
    with path.open("wb") as fh:
        fh.write(struct.pack("<HHH", 0, 1, len(blobs)))
        cursor = offset
        for width, height, data in blobs:
            fh.write(
                struct.pack(
                    "<BBBBHHII",
                    0 if width >= 256 else width,
                    0 if height >= 256 else height,
                    0,
                    0,
                    1,
                    32,
                    len(data),
                    cursor,
                )
            )
            cursor += len(data)
        for _width, _height, data in blobs:
            fh.write(data)


def main() -> None:
    root = Path(__file__).resolve().parents[1]

    chrome = tiled_icon(1024)
    etch = etch_icon(1024)

    out_build = root / "build" / "icon.png"
    out_public = root / "src" / "renderer" / "public" / "app-icon.png"
    out_etch = root / "src" / "renderer" / "public" / "app-icon-etch.png"
    out_build.parent.mkdir(parents=True, exist_ok=True)
    out_public.parent.mkdir(parents=True, exist_ok=True)
    chrome.save(out_build, "PNG")
    chrome.save(out_public, "PNG")
    etch.save(out_etch, "PNG")

    icons_dir = root / "build" / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)
    for size in HICOLOR_SIZES:
        tiled_icon(size).save(icons_dir / f"{size}x{size}.png", "PNG")

    ico_path = root / "build" / "icon.ico"
    write_png_ico(ico_path, [tiled_icon(size) for size in ICO_SIZES])
    fav_path = root / "src" / "renderer" / "public" / "favicon.ico"
    write_png_ico(fav_path, [tiled_icon(size) for size in FAVICON_SIZES])

    print(f"Wrote {out_build}")
    print(f"Wrote {out_public}")
    print(f"Wrote {out_etch}")
    print(f"Wrote {ico_path}")
    print(f"Wrote {fav_path}")
    print(f"Wrote {icons_dir} ({len(HICOLOR_SIZES)} sizes)")


if __name__ == "__main__":
    main()
