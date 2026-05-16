#!/usr/bin/env python3
"""Generate the Claude Heartbeat app icon as a 1024x1024 PNG.
Run once: python3 make_icon.py  →  creates assets/icon.png
Then:     make_iconset.sh       →  creates assets/icon.icns
"""
import struct, zlib, math, os

SIZE = 1024
OUT  = os.path.join(os.path.dirname(__file__), 'assets', 'icon.png')
os.makedirs(os.path.dirname(OUT), exist_ok=True)

# ── colour palette ────────────────────────────────────────────────────────────
BG   = (28,  28,  32,  255)   # dark charcoal (background)
MIC  = (255, 255, 255, 255)   # white mic body
RING = (80, 160, 255, 255)    # blue sound-ring
TRNP = (0,   0,   0,   0)    # transparent

# ── pixel grid ────────────────────────────────────────────────────────────────
px = [[TRNP] * SIZE for _ in range(SIZE)]

def dist(x, y, cx, cy):
    return math.sqrt((x - cx) ** 2 + (y - cy) ** 2)

cx = cy = SIZE // 2

# ── background: filled circle ─────────────────────────────────────────────────
R_BG = int(SIZE * 0.46)
for y in range(SIZE):
    for x in range(SIZE):
        if dist(x, y, cx, cy) <= R_BG:
            px[y][x] = BG

# ── mic body: capsule (rectangle + semicircle top) ────────────────────────────
# Position mic slightly above centre so stand + base fit
MIC_CX   = cx
MIC_W    = 130          # half-width of rectangle
MIC_RECT_TOP = cy - 240
MIC_RECT_BOT = cy +  60
MIC_CAP_R    = MIC_W   # radius of the top semicircle

for y in range(SIZE):
    for x in range(SIZE):
        if px[y][x][3] == 0:
            continue
        dx, dy = x - MIC_CX, y - MIC_RECT_TOP
        # Top semicircle
        if dy < 0 and dist(x, y, MIC_CX, MIC_RECT_TOP) <= MIC_CAP_R:
            px[y][x] = MIC
            continue
        # Rectangle body
        if MIC_RECT_TOP <= y <= MIC_RECT_BOT and abs(x - MIC_CX) <= MIC_W:
            px[y][x] = MIC

# ── blue sound rings (two partial arcs on each side) ──────────────────────────
RING_CX, RING_CY = MIC_CX, (MIC_RECT_TOP + MIC_RECT_BOT) // 2
for ring_r, ring_w in [(MIC_W + 55, 18), (MIC_W + 105, 18)]:
    for y in range(SIZE):
        for x in range(SIZE):
            if px[y][x][3] == 0:
                continue
            d = dist(x, y, RING_CX, RING_CY)
            if ring_r - ring_w <= d <= ring_r:
                # Only draw arcs to left and right (not top/bottom)
                angle = math.degrees(math.atan2(y - RING_CY, x - RING_CX))
                if 30 < abs(angle) < 150:
                    px[y][x] = RING

# ── mic stand: vertical line ──────────────────────────────────────────────────
STAND_W   = 22
STAND_TOP = MIC_RECT_BOT
STAND_BOT = MIC_RECT_BOT + 140
for y in range(STAND_TOP, min(STAND_BOT, SIZE)):
    for x in range(MIC_CX - STAND_W // 2, MIC_CX + STAND_W // 2 + 1):
        if 0 <= x < SIZE and px[y][x][3] != 0:
            px[y][x] = MIC

# ── base: U-shape (two side legs + bottom bar) ────────────────────────────────
BASE_W    = 170    # half-width of base
BASE_Y    = STAND_BOT
LEG_H     = 90
BAR_H     = 22
LEG_W     = 22

# Bottom horizontal bar
for y in range(BASE_Y, min(BASE_Y + BAR_H, SIZE)):
    for x in range(MIC_CX - BASE_W, MIC_CX + BASE_W + 1):
        if 0 <= x < SIZE and px[y][x][3] != 0:
            px[y][x] = MIC

# Left leg
for y in range(BASE_Y - LEG_H, BASE_Y + BAR_H):
    for x in range(MIC_CX - BASE_W, MIC_CX - BASE_W + LEG_W + 1):
        if 0 <= x < SIZE and 0 <= y < SIZE and px[y][x][3] != 0:
            px[y][x] = MIC

# Right leg
for y in range(BASE_Y - LEG_H, BASE_Y + BAR_H):
    for x in range(MIC_CX + BASE_W - LEG_W, MIC_CX + BASE_W + 1):
        if 0 <= x < SIZE and 0 <= y < SIZE and px[y][x][3] != 0:
            px[y][x] = MIC

# ── write PNG ─────────────────────────────────────────────────────────────────

def crc32(data):
    return struct.pack('>I', zlib.crc32(data) & 0xffffffff)

def chunk(tag, data):
    t = tag.encode()
    return struct.pack('>I', len(data)) + t + data + crc32(t + data)

raw = bytearray()
for row in px:
    raw += b'\x00'
    for r, g, b, a in row:
        raw += bytes([r, g, b, a])

with open(OUT, 'wb') as f:
    f.write(b'\x89PNG\r\n\x1a\n')
    f.write(chunk('IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)))
    f.write(chunk('IDAT', zlib.compress(bytes(raw), 6)))
    f.write(chunk('IEND', b''))

print(f'wrote {OUT}')
