"""Generates the PNG app icons (pure Python, no dependencies)."""
import math, struct, zlib, pathlib

def png(size):
    rows = []
    cx = cy = size / 2
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            t = (x + y) / (2 * size)
            r, g, b = (int(a + (c - a) * t) for a, c in zip((18, 22, 40), (46, 34, 24)))  # midnight -> bronze
            d = math.hypot(x - cx * 0.92, y - cy * 0.92) / size
            glow = max(0, 1 - abs(d - 0.24) / 0.05)           # glass ring
            handle = 0
            ax, ay = (x - cx * 0.92), (y - cy * 0.92)
            u = (ax + ay) / math.sqrt(2); v = (ax - ay) / math.sqrt(2)  # rotate 45deg
            if 0.24 * size < u < 0.40 * size and abs(v) < 0.028 * size: handle = 1
            k = max(glow, handle)
            r = int(r + (230 - r) * k * 0.95); g = int(g + (194 - g) * k * 0.95); b = int(b + (122 - b) * k * 0.95)
            row += bytes((r, g, b))
        rows.append(bytes(row))
    raw = b''.join(rows)
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

out = pathlib.Path(__file__).parent / 'icons'
out.mkdir(exist_ok=True)
for s in (180, 192, 512):
    (out / f'icon-{s}.png').write_bytes(png(s))
print('icons written')
