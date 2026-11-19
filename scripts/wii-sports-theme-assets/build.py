#!/usr/bin/env python3
"""Build public/themes/wiisports from an extracted Wii Sports disc (RSPE01, US).

Usage: uv run --with pillow --with numpy scripts/wii-sports-theme-assets/build.py <disc>/files

Reads the disc's own archives as data: Yaz0 + U8 (.carc/.arc), TPL textures and
the BREFT pointer pack. Nothing from the disc is executed. The colours applied
here are the layouts' own material colours (cPadCursor_00.brlyt) or were measured from 1080p captures of the running game;
docs/retro-themes.md has the reasoning and docs/wii-sports-theme-assets.json
the provenance, which this script rewrites.
"""
import hashlib, json, struct, sys
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/themes/wiisports'
SOURCE = 'Wii Sports (USA, RSPE01), disc filesystem extracted with wit'

# ---------- containers ----------

def yaz0(d):
    if d[:4] != b'Yaz0': return d
    size = struct.unpack('>I', d[4:8])[0]; out = bytearray(); i = 16
    while len(out) < size:
        code = d[i]; i += 1
        for bit in range(8):
            if len(out) >= size: break
            if code & (0x80 >> bit): out.append(d[i]); i += 1
            else:
                b1, b2 = d[i], d[i + 1]; i += 2; dist = ((b1 & 0xF) << 8 | b2) + 1; n = b1 >> 4
                if n == 0: n = d[i] + 0x12; i += 1
                else: n += 2
                for _ in range(n): out.append(out[-dist])
    return bytes(out)

def u8(d):
    d = yaz0(d); assert d[:4] == b'\x55\xaa\x38\x2d'
    root = struct.unpack('>I', d[4:8])[0]; n = struct.unpack('>I', d[root + 8:root + 12])[0]; strings = root + n * 12
    files = {}; dirs = [(n, '')]
    for i in range(1, n):
        e = root + i * 12; kind = d[e]; name_off = int.from_bytes(d[e + 1:e + 4], 'big'); a, b = struct.unpack('>II', d[e + 4:e + 12])
        while i >= dirs[-1][0]: dirs.pop()
        name = d[strings + name_off:d.index(b'\0', strings + name_off)].decode()
        if kind == 1: dirs.append((b, dirs[-1][1] + name + '/'))
        else: files[dirs[-1][1] + name] = d[a:a + b]
    return files

# ---------- GX textures ----------

BLOCK = {0: (8, 8, 4), 1: (8, 4, 8), 2: (8, 4, 8), 3: (4, 4, 16), 4: (4, 4, 16), 5: (4, 4, 16), 6: (4, 4, 32)}

def rgb5a3(v):
    if v & 0x8000: return ((v >> 10 & 31) * 255 // 31, (v >> 5 & 31) * 255 // 31, (v & 31) * 255 // 31, 255)
    return ((v >> 8 & 15) * 17, (v >> 4 & 15) * 17, (v & 15) * 17, (v >> 12 & 7) * 255 // 7)

def decode(d, w, h, fmt):
    bw, bh, bpp = BLOCK[fmt]; out = np.zeros((h + bh, w + bw, 4), np.uint8); p = 0
    for by in range(0, h, bh):
        for bx in range(0, w, bw):
            if fmt == 6:
                ar, gb = d[p:p + 32], d[p + 32:p + 64]; p += 64
                for i in range(16): out[by + i // 4, bx + i % 4] = (ar[2 * i + 1], gb[2 * i], gb[2 * i + 1], ar[2 * i])
                continue
            for y in range(bh):
                for x in range(bw):
                    if bpp == 4:
                        v = d[p >> 1]; v = (v >> 4) if p % 2 == 0 else (v & 15); p += 1; px = (v * 17,) * 3 + (255,)
                    elif bpp == 8:
                        v = d[p]; p += 1; px = (v, v, v, 255) if fmt == 1 else ((v & 15) * 17,) * 3 + ((v >> 4) * 17,)
                    else:
                        v = struct.unpack('>H', d[p:p + 2])[0]; p += 2
                        if fmt == 3: px = (v & 255,) * 3 + (v >> 8,)
                        elif fmt == 4: px = ((v >> 11 & 31) * 255 // 31, (v >> 5 & 63) * 255 // 63, (v & 31) * 255 // 31, 255)
                        else: px = rgb5a3(v)
                    out[by + y, bx + x] = px
    return Image.fromarray(out[:h, :w], 'RGBA')

def tpl(d):
    table = struct.unpack('>I', d[8:12])[0]; header = struct.unpack('>I', d[table:table + 4])[0]
    h, w, fmt, off = struct.unpack('>HHII', d[header:header + 12])
    return decode(d[off:], w, h, fmt)

def breft(d):
    t = 0x60; n = struct.unpack('>H', d[t + 4:t + 6])[0]; p = t + 8; out = {}
    for _ in range(n):
        length = struct.unpack('>H', d[p:p + 2])[0]; name = d[p + 2:p + 2 + length].rstrip(b'\0').decode(); p += 2 + length
        off = struct.unpack('>I', d[p:p + 4])[0]; p += 8; h = t + off
        w, hh, size, fmt = struct.unpack('>HHIB', d[h + 4:h + 13])
        out[name] = decode(d[h + 0x20:h + 0x20 + size], w, hh, fmt)
    return out

# ---------- image helpers ----------

def arr(im): return np.asarray(im.convert('RGBA')).astype(np.float32)
def img(a): return Image.fromarray(np.clip(a + 0.5, 0, 255).astype(np.uint8), 'RGBA')

def multiply(im, rgb):
    a = arr(im); a[..., :3] *= np.array(rgb, np.float32); return img(a)

def two_tone(im, black, white):
    """A layout material: the texture's black maps to one colour, its white to the other."""
    a = arr(im); t = a[..., :1] / 255
    a[..., :3] = np.array(black, np.float32) * (1 - t) + np.array(white, np.float32) * t; return img(a)

def night(im, lo, hi, edge):
    """Dark appearance: the navy outline turns light, the pale face turns dark."""
    a = arr(im); lum = (a[..., :3] @ np.array([0.299, 0.587, 0.114], np.float32))[..., None] / 255
    face = np.array(lo, np.float32) + (np.array(hi, np.float32) - np.array(lo, np.float32)) * np.clip((lum - 0.62) / 0.36, 0, 1)
    t = np.clip((lum - 0.2) / 0.35, 0, 1)
    a[..., :3] = np.array(edge, np.float32) * (1 - t) + face * t; return img(a)

def over(base, top, xy=(0, 0)):
    out = base.copy(); layer = Image.new('RGBA', base.size); layer.paste(top, xy); return Image.alpha_composite(out, layer)

def pointer(mask, size):
    """The P1 pointer: nw4r's hand (white fill, black outline) in player one's blue."""
    a = arr(mask); t = a[..., :1] / 255; h = a.shape[0]
    fill = np.linspace(0, 1, h, dtype=np.float32)[:, None, None] ** 1.6
    fill = np.array([255, 255, 255], np.float32) * (1 - fill) + np.array([196, 214, 255], np.float32) * fill
    a[..., :3] = np.array([18, 62, 232], np.float32) * (1 - t) + fill * t
    hand = img(a); shadow = Image.new('RGBA', hand.size); s = arr(hand); s[..., :3] = (0, 30, 80); s[..., 3] *= 0.3
    out = over(over(Image.new('RGBA', hand.size), img(s), (2, 2)), hand)
    return out.resize((size, size), Image.LANCZOS)

def main(files):
    files = Path(files)
    def arc(carc, name): return u8(u8((files / carc).read_bytes())[name])
    sports_top = arc('US/RPSportsCommon/local.carc', 'sportsTop.arc')
    menu = arc('US/RPSportsCommon/local.carc', 'menuCommon.arc')
    players = arc('US/RPCommon/local.carc', 'playerSelect.arc')
    static = u8((files / 'US/SportsStatic/local.carc').read_bytes())
    pad = u8(static['cPadCursor.arc'])
    hands = breft(u8((files / 'Common/SportsStatic/common.carc').read_bytes())['nw4r_defcursor_pack.breft'])
    tex = lambda a, n: tpl(a[f'timg/{n}.tpl'])

    made = {}
    def save(name, im, source, method):
        OUT.mkdir(parents=True, exist_ok=True); im.save(OUT / name, optimize=True)
        made[name] = (source, method)

    # Push buttons. Hot is the texture times the colour the game lays over it while the pointer is on a button.
    HOT = (0.676, 0.965, 1.0)
    for name, source, slug in (('ist_button_04', 'US/RPSportsCommon/local.carc: sportsTop.arc timg/ist_button_04.tpl', 'button'),
                               ('ist_button_06', 'US/RPSportsCommon/local.carc: sportsTop.arc timg/ist_button_06.tpl', 'tile')):
        raw = tex(sports_top, name)
        save(f'{slug}.png', raw, source, 'Decoded RGB5A3 texture, unmodified')
        save(f'{slug}-hot.png', multiply(raw, HOT), source, 'Texture multiplied by (0.676, 0.965, 1.0), the selected-button colour measured from the running game')
        save(f'{slug}-night.png', night(raw, (22, 58, 72), (44, 92, 108), (132, 214, 228)), source, "Dark appearance, not in the game: outline lightened, face darkened by luminance")
        save(f'{slug}-night-hot.png', night(raw, (40, 150, 166), (92, 206, 220), (4, 30, 40)), source, 'Dark appearance, not in the game: face recoloured cyan by luminance')

    # Player-select tabs.
    raw = tex(players, 'ist_tab_00')
    save('tab.png', raw, 'US/RPCommon/local.carc: playerSelect.arc timg/ist_tab_00.tpl', 'Decoded texture, unmodified')
    save('tab-hot.png', multiply(raw, (0.20, 0.70, 0.74)), 'US/RPCommon/local.carc: playerSelect.arc timg/ist_tab_00.tpl', 'Texture multiplied by the selected-tab teal measured from the running game')

    # The pad cursor: one corner texture drawn four times, mirrored, as cPadCursor_00.brlyt places it.
    corner = two_tone(tpl(pad['timg/cPadCursor_00.tpl']), (100, 100, 100), (255, 255, 255)); n = corner.width
    bracket = Image.new('RGBA', (n * 2 + 4, n * 2 + 4))
    for flip_x, flip_y in ((0, 0), (1, 0), (0, 1), (1, 1)):
        c = corner
        if flip_x: c = c.transpose(Image.FLIP_LEFT_RIGHT)
        if flip_y: c = c.transpose(Image.FLIP_TOP_BOTTOM)
        bracket.paste(c, (flip_x * (n + 4), flip_y * (n + 4)))
    save('bracket.png', bracket, 'US/SportsStatic/local.carc: cPadCursor.arc timg/cPadCursor_00.tpl', 'Four mirrored corners in the material colours of cPadCursor_00.brlyt (100,100,100 and white)')
    save('bracket-night.png', bracket_night(corner, n), 'US/SportsStatic/local.carc: cPadCursor.arc timg/cPadCursor_00.tpl', 'Dark appearance, not in the game: the same corners in pale cyan')

    save('menu-line.png', tex(menu, 'ist_menuLine_00'), 'US/RPSportsCommon/local.carc: menuCommon.arc timg/ist_menuLine_00.tpl', 'Decoded texture, unmodified')
    for slug, key in (('cursor', 'defcursor_final64_a'), ('cursor-grab', 'defcursor_final64_b'), ('cursor-open', 'defcursor_final64_c')):
        for suffix, size in (('', 40), ('@2x', 80)):
            save(f'{slug}{suffix}.png', pointer(hands[key], size), f'Common/SportsStatic/common.carc: nw4r_defcursor_pack.breft {key}', f'IA8 hand coloured player-one blue with its shadow, scaled to {size}px')

    record = {
        'notice': "Wii Sports artwork remains the property of Nintendo. These files are decoded from the owner's own disc for a personal theme and are not relicensed under the application code license.",
        'source': SOURCE,
        'script': 'scripts/wii-sports-theme-assets/build.py',
        'directory': 'public/themes/wiisports',
        'files': {name: {'source': source, 'method': method, 'sha256': hashlib.sha256((OUT / name).read_bytes()).hexdigest()} for name, (source, method) in sorted(made.items())},
    }
    (ROOT / 'docs/wii-sports-theme-assets.json').write_text(json.dumps(record, indent=2) + '\n')
    print(f'{len(made)} files -> {OUT}')

def bracket_night(corner, n):
    a = arr(corner); grey = a[..., :1] / 255
    a[..., :3] = np.array([214, 244, 248], np.float32) * (1 - (grey - 100 / 255) / (155 / 255)) + np.array([8, 36, 52], np.float32) * ((grey - 100 / 255) / (155 / 255))
    corner = img(a); out = Image.new('RGBA', (n * 2 + 4, n * 2 + 4))
    for flip_x, flip_y in ((0, 0), (1, 0), (0, 1), (1, 1)):
        c = corner
        if flip_x: c = c.transpose(Image.FLIP_LEFT_RIGHT)
        if flip_y: c = c.transpose(Image.FLIP_TOP_BOTTOM)
        out.paste(c, (flip_x * (n + 4), flip_y * (n + 4)))
    return out

if __name__ == '__main__':
    main(sys.argv[1])
