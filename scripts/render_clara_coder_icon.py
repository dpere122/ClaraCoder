"""
Raster Clara Coder app icons from the slate mark.

OS / taskbar icons sit on a filled rounded tile so the mark reads at 16–32px.
Chrome and etch assets stay the isolated silhouette.

Run from repo root:
  python scripts/render_clara_coder_icon.py
  npm run render:icon
"""

from __future__ import annotations

import io
import struct
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    print("Install Pillow: pip install Pillow", file=sys.stderr)
    sys.exit(1)

HICOLOR_SIZES = (16, 24, 32, 48, 64, 96, 128, 256, 512, 1024)
FAVICON_SIZES = (16, 32, 48)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)

# Dark plate from the default theme surface; keeps the charcoal C readable.
PLATE = (28, 32, 26, 255)
MARK_FILL = 0.90
TILE_INSET = 0.0


def crop_alpha(src: Image.Image) -> Image.Image:
    bbox = src.getbbox()
    if bbox is None:
        raise SystemExit("Logo source is fully transparent.")
    return src.crop(bbox)


def fit_mark(src: Image.Image, size: int, fill: float) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    target = max(1, int(round(size * fill)))
    thumb = src.copy()
    thumb.thumbnail((target, target), Image.Resampling.LANCZOS)
    if size <= 64:
        thumb = thumb.filter(ImageFilter.UnsharpMask(radius=1.1, percent=160, threshold=1))
    canvas.paste(thumb, ((size - thumb.size[0]) // 2, (size - thumb.size[1]) // 2), thumb)
    return canvas


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


def rounded_plate(size: int, fill: tuple[int, int, int, int]) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = max(2, int(round(size * 0.22)))
    inset = int(round(size * TILE_INSET))
    draw.rounded_rectangle(
        [inset, inset, size - 1 - inset, size - 1 - inset],
        radius=radius,
        fill=fill,
    )
    return img


def tiled_icon(mark: Image.Image, size: int) -> Image.Image:
    plate = rounded_plate(size, PLATE)
    glyph = fit_mark(mark, size, MARK_FILL)
    plate.alpha_composite(glyph)
    return plate


def white_silhouette(src: Image.Image) -> Image.Image:
    out = src.copy()
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 0:
                px[x, y] = (255, 255, 255, a)
    return out


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    src_path = root / "assets" / "clara-logo-slate.png"
    if not src_path.is_file():
        print(f"Missing source mark: {src_path}", file=sys.stderr)
        sys.exit(1)

    mark = crop_alpha(Image.open(src_path).convert("RGBA"))

    chrome = tiled_icon(mark, 1024)
    etch = fit_mark(white_silhouette(mark), 1024, 0.92)

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
        tiled_icon(mark, size).save(icons_dir / f"{size}x{size}.png", "PNG")

    ico_path = root / "build" / "icon.ico"
    write_png_ico(ico_path, [tiled_icon(mark, size) for size in ICO_SIZES])
    fav_path = root / "src" / "renderer" / "public" / "favicon.ico"
    write_png_ico(fav_path, [tiled_icon(mark, size) for size in FAVICON_SIZES])

    print(f"Wrote {out_build}")
    print(f"Wrote {out_public}")
    print(f"Wrote {out_etch}")
    print(f"Wrote {ico_path}")
    print(f"Wrote {fav_path}")
    print(f"Wrote {icons_dir} ({len(HICOLOR_SIZES)} sizes)")


if __name__ == "__main__":
    main()
