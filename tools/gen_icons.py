#!/usr/bin/env python3
"""Render the app icons (PNG) without any third-party dependency.

Usage: python3 tools/gen_icons.py apps/web/public/icons
"""

import math
import struct
import sys
import zlib
from pathlib import Path

BG = (11, 16, 32)
ARC = (56, 189, 248)
BALL = (250, 204, 21)


def png(path: Path, size: int, pixels: bytes) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    rows = b"".join(b"\x00" + pixels[y * size * 4 : (y + 1) * size * 4] for y in range(size))
    data = b"\x89PNG\r\n\x1a\n"
    data += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(rows, 9))
    data += chunk(b"IEND", b"")
    path.write_bytes(data)


def coverage(d: float) -> float:
    """Anti-aliased coverage for signed distance d (negative = inside), in pixels."""
    return max(0.0, min(1.0, 0.5 - d))


def mix(base: tuple[int, int, int], top: tuple[int, int, int], a: float) -> tuple[int, ...]:
    return tuple(round(base[i] + (top[i] - base[i]) * a) for i in range(3))


def render(size: int, maskable: bool) -> bytes:
    out = bytearray()
    c = size / 2
    corner = 0 if maskable else size * 0.22
    scale = 0.78 if maskable else 1.0  # keep the art inside the maskable safe zone
    ring_r, ring_w = size * 0.27 * scale, size * 0.075 * scale
    ball_r = size * 0.085 * scale
    ball_c = (c + ring_r * math.cos(-0.6), c + ring_r * math.sin(-0.6))
    for y in range(size):
        for x in range(size):
            px, py = x + 0.5, y + 0.5
            # Rounded-square background.
            qx, qy = abs(px - c) - (c - corner), abs(py - c) - (c - corner)
            bg_d = math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - corner
            alpha = coverage(bg_d)
            r, g, b = BG
            # Arc: a ring with a gap on the upper right.
            ang = math.atan2(py - c, px - c)
            ring_d = abs(math.hypot(px - c, py - c) - ring_r) - ring_w / 2
            if not (-1.25 < ang < 0.05):
                r, g, b = mix((r, g, b), ARC, coverage(ring_d))
            ball_d = math.hypot(px - ball_c[0], py - ball_c[1]) - ball_r
            r, g, b = mix((r, g, b), BALL, coverage(ball_d))
            out += bytes((r, g, b, round(alpha * 255)))
    return bytes(out)


def main() -> None:
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for name, size, maskable in (
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, True),
    ):
        png(out / name, size, render(size, maskable))
    (out / "icon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        '<rect width="100" height="100" rx="22" fill="#0b1020"/>'
        '<path d="M77 47A27 27 0 1 1 63 26" fill="none" stroke="#38bdf8" stroke-width="7.5"'
        ' stroke-linecap="round"/><circle cx="72.3" cy="34.8" r="8.5" fill="#facc15"/></svg>\n'
    )


if __name__ == "__main__":
    main()
