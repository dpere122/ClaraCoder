"""
Raster Clara Coder app icon: block-terminal 'Cc' on fully transparent RGBA (no fake checkerboard).

Run from repo root:
  python scripts/render_clara_coder_icon.py
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("Install Pillow: pip install Pillow", file=sys.stderr)
    sys.exit(1)

# Compact block glyphs so 'Cc' can scale larger on 1024 canvas (same width per row in each glyph)
GLYPH_C_UPPER = [
    ".######.",
    "##....##",
    "##.....#",
    "##.....",
    "##.....",
    "##.....",
    "##.....#",
    "##....##",
    ".######.",
]

GLYPH_C_LOWER = [
    "######",
    "#....#",
    "#.....",
    "#.....",
    "#....#",
    "######",
]


def _normalize_rows(rows: list[str]) -> list[str]:
    w = max(len(r) for r in rows)
    return [r.ljust(w, ".") for r in rows]


def _filled_cells(rows: list[str]) -> set[tuple[int, int]]:
    rows = _normalize_rows(rows)
    out: set[tuple[int, int]] = set()
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == "#":
                out.add((x, y))
    return out


def _draw_glyph(
    draw: ImageDraw.ImageDraw,
    cells: set[tuple[int, int]],
    origin_x: int,
    origin_y: int,
    cell: int,
    fill: tuple[int, int, int, int],
    scanline_dark: tuple[int, int, int, int],
) -> None:
    """Draw chunky cells with horizontal scanlines (only on opaque letter pixels)."""
    for (gx, gy) in cells:
        x0 = origin_x + gx * cell
        y0 = origin_y + gy * cell
        x1 = x0 + cell - 1
        y1 = y0 + cell - 1
        draw.rectangle([x0, y0, x1, y1], fill=fill)
        # CRT scanlines: every 3rd row inside the cell, slightly darker (still inside glyph)
        for yy in range(y0, y1 + 1):
            if (yy - y0) % 3 == 1:
                draw.line([(x0, yy), (x1, yy)], fill=scanline_dark)


def render(size: int = 1024) -> Image.Image:
    upper = _filled_cells(GLYPH_C_UPPER)
    lower = _filled_cells(GLYPH_C_LOWER)

    uw = max(x for x, _ in upper) + 1
    uh = max(y for _, y in upper) + 1
    lw = max(x for x, _ in lower) + 1
    lh = max(y for _, y in lower) + 1

    margin = max(16, int(size * 0.028))
    inner_w = size - 2 * margin
    inner_h = size - 2 * margin

    # Maximize cell_u: tall C fills height; wide Cc must fit inner_w
    best_u = 8
    for cell_u in range(inner_h // uh, 7, -1):
        cell_l = max(6, int(cell_u * 0.58))
        gap = max(2, cell_u // 10)
        total_w = uw * cell_u + gap + lw * cell_l
        if total_w <= inner_w:
            best_u = cell_u
            break

    cell_u = best_u
    cell_l = max(6, int(cell_u * 0.58))
    gap = max(2, cell_u // 10)
    total_w = uw * cell_u + gap + lw * cell_l

    height_u = uh * cell_u
    height_l = lh * cell_l
    base_y = margin + (inner_h - height_u) // 2
    y_upper = base_y
    y_lower = base_y + height_u - height_l

    x_upper = margin + (inner_w - total_w) // 2
    x_lower = x_upper + uw * cell_u + gap

    phosphor = (45, 255, 120, 255)
    scan_dark = (20, 160, 70, 255)

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    _draw_glyph(draw, upper, x_upper, y_upper, cell_u, phosphor, scan_dark)
    _draw_glyph(draw, lower, x_lower, y_lower, cell_l, phosphor, scan_dark)
    return img


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    img = render(1024)
    out_build = root / "build" / "icon.png"
    out_public = root / "src" / "renderer" / "public" / "app-icon.png"
    out_build.parent.mkdir(parents=True, exist_ok=True)
    out_public.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_build, "PNG")
    img.save(out_public, "PNG")
    print(f"Wrote {out_build}")
    print(f"Wrote {out_public}")


if __name__ == "__main__":
    main()
