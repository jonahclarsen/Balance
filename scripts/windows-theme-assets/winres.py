#!/usr/bin/env python3
"""Read icons and cursors out of Windows files as data; nothing here executes them.

  winres.py icons <pe-file> <outdir> [size]     every icon group at a given size (default 16)
  winres.py cursor <file.cur> <out.png> [size]  a .cur file; prints the hotspot
  winres.py pecursor <pe-file> <group> <out.png>  a cursor resource; prints the hotspot
"""
import os, struct, sys, zlib

RT_CURSOR, RT_ICON, RT_GROUP_CURSOR, RT_GROUP_ICON = 1, 3, 12, 14


def png(w, h, rgba):
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    raw = b''.join(b'\0' + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def dib(d):
    """A DIB with AND mask, as stored in icons and cursors, to (w, h, RGBA)."""
    hs, w, h2, _, bpp, comp = struct.unpack_from('<IiiHHI', d, 0)
    h = abs(h2) // 2
    used = struct.unpack_from('<I', d, 32)[0]
    pal_n = used or (1 << bpp if bpp <= 8 else 0)
    pal = d[hs:hs + pal_n * 4]
    o = hs + pal_n * 4
    xs = ((w * bpp + 31) // 32) * 4
    ms = ((w + 31) // 32) * 4
    xor = d[o:o + xs * h]
    mask = d[o + xs * h:o + xs * h + ms * h]
    out = bytearray(w * h * 4)
    has_alpha = bpp == 32 and any(xor[i + 3] for i in range(0, len(xor), 4))
    for y in range(h):
        sy = h - 1 - y
        for x in range(w):
            m = (mask[sy * ms + x // 8] >> (7 - x % 8)) & 1 if mask else 0
            p = sy * xs
            if bpp == 32:
                b, g, r, a = xor[p + x * 4:p + x * 4 + 4]
                if not has_alpha:
                    a = 0 if m else 255
            elif bpp == 24:
                b, g, r = xor[p + x * 3:p + x * 3 + 3]
                a = 0 if m else 255
            else:
                if bpp == 8:
                    i = xor[p + x]
                elif bpp == 4:
                    i = (xor[p + x // 2] >> (0 if x % 2 else 4)) & 15
                else:
                    i = (xor[p + x // 8] >> (7 - x % 8)) & 1
                b, g, r = pal[i * 4:i * 4 + 3]
                a = 0 if m else 255
                # AND=1 with a set XOR bit inverts the screen; draw it black.
                if m and (r or g or b):
                    r, g, b, a = 0, 0, 0, 255
            out[(y * w + x) * 4:(y * w + x) * 4 + 4] = bytes((r, g, b, a))
    return w, h, bytes(out)


def pe_resources(path):
    b = open(path, 'rb').read()
    pe = struct.unpack_from('<I', b, 0x3c)[0]
    nsec = struct.unpack_from('<H', b, pe + 6)[0]
    optsz = struct.unpack_from('<H', b, pe + 20)[0]
    magic = struct.unpack_from('<H', b, pe + 24)[0]
    rva = struct.unpack_from('<I', b, pe + 24 + (112 if magic == 0x20b else 96) + 16)[0]
    secs = [struct.unpack_from('<IIII', b, pe + 24 + optsz + 40 * i + 8) for i in range(nsec)]

    def r2o(r):
        for vs, va, rs, rp in secs:
            if va <= r < va + max(vs, rs):
                return r - va + rp
        raise ValueError(r)
    base = r2o(rva)

    def name(v):
        if v & 0x80000000:
            o = base + (v & 0x7fffffff)
            n = struct.unpack_from('<H', b, o)[0]
            return b[o + 2:o + 2 + n * 2].decode('utf-16le')
        return v

    res = {}

    def walk(off, p):
        nn, ni = struct.unpack_from('<HH', b, off + 12)
        for i in range(nn + ni):
            nm, data = struct.unpack_from('<II', b, off + 16 + 8 * i)
            q = p + [name(nm)]
            if data & 0x80000000:
                walk(base + (data & 0x7fffffff), q)
            else:
                drva, dsz = struct.unpack_from('<II', b, base + data)
                res.setdefault(q[0], {}).setdefault(q[1], r2o(drva) and b[r2o(drva):r2o(drva) + dsz])
    walk(base, [])
    return res


def icon_frame(data):
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return data
    w, h, rgba = dib(data)
    return png(w, h, rgba)


def icons(path, out, size=16):
    res = pe_resources(path)
    os.makedirs(out, exist_ok=True)
    for gid, g in res.get(RT_GROUP_ICON, {}).items():
        count = struct.unpack_from('<H', g, 4)[0]
        best = None
        for i in range(count):
            w, h, _, _, _, bpp, sz, iid = struct.unpack_from('<BBBBHHIH', g, 6 + i * 14)
            w = w or 256
            if w == size and (best is None or bpp > best[0]):
                best = (bpp, iid)
        if best and best[1] in res.get(RT_ICON, {}):
            try:
                open(os.path.join(out, f'{gid}.png'), 'wb').write(icon_frame(res[RT_ICON][best[1]]))
            except Exception as e:
                print('skip', gid, e, file=sys.stderr)


def cursor_file(path, out, size=32):
    d = open(path, 'rb').read()
    count = struct.unpack_from('<H', d, 4)[0]
    pick = None
    for i in range(count):
        w, h, _, _, hx, hy, sz, off = struct.unpack_from('<BBBBHHII', d, 6 + i * 16)
        w = w or 256
        if pick is None or w == size:
            pick = (hx, hy, sz, off)
        if w == size:
            break
    hx, hy, sz, off = pick
    frame = d[off:off + sz]
    open(out, 'wb').write(icon_frame(frame))
    print(hx, hy)


def pe_cursor(path, group, out):
    res = pe_resources(path)
    g = res[RT_GROUP_CURSOR][int(group)]
    count = struct.unpack_from('<H', g, 4)[0]
    cid = struct.unpack_from('<H', g, 6 + (count - 1) * 14 + 12)[0]
    d = res[RT_CURSOR][cid]
    hx, hy = struct.unpack_from('<HH', d, 0)
    w, h, rgba = dib(d[4:])
    open(out, 'wb').write(png(w, h, rgba))
    print(hx, hy)


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'icons':
        icons(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 16)
    elif cmd == 'cursor':
        cursor_file(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 32)
    elif cmd == 'pecursor':
        pe_cursor(sys.argv[2], sys.argv[3], sys.argv[4])
