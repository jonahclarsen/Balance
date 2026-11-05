#!/usr/bin/env python3
"""Minimal PE resource dumper. Reads a PE as data; never executes it.
usage: peres.py <file> <outdir> [type-regex]"""
import os, re, struct, sys

RT = {1: 'CURSOR', 2: 'BITMAP', 3: 'ICON', 4: 'MENU', 5: 'DIALOG', 6: 'STRING', 10: 'RCDATA', 12: 'GROUP_CURSOR', 14: 'GROUP_ICON', 16: 'VERSION', 24: 'MANIFEST'}


def main(path, out, typere=None):
    b = open(path, 'rb').read()
    pe = struct.unpack_from('<I', b, 0x3c)[0]
    assert b[pe:pe + 4] == b'PE\0\0'
    nsec = struct.unpack_from('<H', b, pe + 6)[0]
    optsz = struct.unpack_from('<H', b, pe + 20)[0]
    magic = struct.unpack_from('<H', b, pe + 24)[0]
    ddoff = pe + 24 + (112 if magic == 0x20b else 96)
    rva, _ = struct.unpack_from('<II', b, ddoff + 2 * 8)
    secs = []
    for i in range(nsec):
        o = pe + 24 + optsz + 40 * i
        vs, va, rs, rp = struct.unpack_from('<IIII', b, o + 8)
        secs.append((va, max(vs, rs), rp))

    def r2o(r):
        for va, sz, rp in secs:
            if va <= r < va + sz:
                return r - va + rp
        raise ValueError(hex(r))

    base = r2o(rva)

    def name(v):
        if v & 0x80000000:
            o = base + (v & 0x7fffffff)
            n = struct.unpack_from('<H', b, o)[0]
            return b[o + 2:o + 2 + n * 2].decode('utf-16le')
        return v

    def walk(off, path_):
        nn, ni = struct.unpack_from('<HH', b, off + 12)
        for i in range(nn + ni):
            nm, data = struct.unpack_from('<II', b, off + 16 + 8 * i)
            p = path_ + [name(nm)]
            if data & 0x80000000:
                yield from walk(base + (data & 0x7fffffff), p)
            else:
                drva, dsz = struct.unpack_from('<II', b, base + data)
                yield p, r2o(drva), dsz

    os.makedirs(out, exist_ok=True)
    rows = []
    for p, o, s in walk(base, []):
        t = RT.get(p[0], p[0]) if isinstance(p[0], int) else p[0]
        rows.append((str(t), str(p[1]), s))
        if typere and not re.search(typere, str(t), re.I):
            continue
        d = b[o:o + s]
        if t == 'BITMAP':
            # Prepend the BITMAPFILEHEADER the resource omits.
            hs, = struct.unpack_from('<I', d, 0)
            bpp, = struct.unpack_from('<H', d, 14)
            cu, = struct.unpack_from('<I', d, 32)
            pal = (cu or (1 << bpp if bpp <= 8 else 0)) * 4
            d = b'BM' + struct.pack('<IHHI', 14 + len(d), 0, 0, 14 + hs + pal) + d
            ext = '.bmp'
        elif d[:8] == b'\x89PNG\r\n\x1a\n':
            ext = '.png'
        elif d[:2] in (b'\xff\xfe',) or re.fullmatch(r'.*(INI|TEXT|STREAM).*', str(t), re.I):
            ext = '.txt'
        else:
            ext = '.bin'
        td = os.path.join(out, re.sub(r'\W+', '_', str(t)))
        os.makedirs(td, exist_ok=True)
        open(os.path.join(td, re.sub(r'[^\w.-]+', '_', str(p[1])) + ext), 'wb').write(d)
    import collections
    c = collections.Counter(r[0] for r in rows)
    print(path, dict(c))


if __name__ == '__main__':
    main(*sys.argv[1:])
