#!/usr/bin/env python3
"""
Générateur procédural de visages MboloChat (expressions codées).

Socle : la tête de `assets/emoji-faces-src/wow.png` (face avant, grands yeux
ouverts). Le script isole la tête (composante connexe d'alpha), efface
yeux/bouche par clonage de fourrure, puis redessine les traits selon une
bibliothèque de types (yeux, sourcils, bouche, accessoires).

Sorties : assets/emoji-faces-proc/<id>.png (512 px, fond transparent, tête seule)
à brancher ensuite dans mbolo-emoji-face-sources.json (dir = ce dossier).

Usage :
  python3 scripts/build-mbolo-emoji-proc.py            # les specs du JSON
  python3 scripts/build-mbolo-emoji-proc.py rieur pleure   # filtrer par id
"""
from pathlib import Path
import json
import math
import random
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "emoji-faces-src" / "wow.png"
OUT = ROOT / "assets" / "emoji-faces-proc"
SPEC = Path(__file__).with_name("mbolo-emoji-proc-spec.json")

SS = 2  # supersampling : dessin à 1024 puis réduction LANCZOS

# Géométrie mesurée sur wow.png (espace 512)
EYE_L = (190, 300, 42, 40)  # cx, cy, rx, ry
EYE_R = (322, 296, 40, 38)
NOSE = (255, 345)
MOUTH = (255, 376)

# Palette échantillonnée sur le socle
FUR_MID = (40, 35, 42)
OUTLINE = (12, 9, 14)
AMBER = (168, 110, 52)
AMBER_DK = (96, 54, 24)
EYE_WHITE = (246, 242, 236)
TONGUE = (188, 74, 76)
TEAR = (116, 184, 236)
SWEAT = (130, 196, 242)
STAR = (240, 198, 72)
HEART = (222, 66, 84)
BLUSH = (206, 92, 96)
MASK_WHITE = (232, 236, 240)


def load_head() -> Image.Image:
    """Tête seule en RGBA 512 : plus grande composante connexe d'alpha."""
    im = Image.open(SRC).convert("RGBA")
    alpha = im.getchannel("A").point(lambda a: 255 if a > 20 else 0)
    w, h = alpha.size
    px = alpha.load()
    seen = bytearray(w * h)
    best = None
    for y in range(h):
        for x in range(w):
            if px[x, y] and not seen[y * w + x]:
                stack = [(x, y)]
                seen[y * w + x] = 1
                comp = []
                while stack:
                    cx, cy = stack.pop()
                    comp.append((cx, cy))
                    for nx, ny in ((cx+1,cy),(cx-1,cy),(cx,cy+1),(cx,cy-1)):
                        if 0 <= nx < w and 0 <= ny < h and px[nx, ny] and not seen[ny*w+nx]:
                            seen[ny*w+nx] = 1
                            stack.append((nx, ny))
                if best is None or len(comp) > len(best):
                    best = comp
    mask = Image.new("L", (w, h), 0)
    mpx = mask.load()
    for x, y in best:
        mpx[x, y] = 255
    mask = mask.filter(ImageFilter.GaussianBlur(0.6))
    head = im.copy()
    head.putalpha(mask)
    return head


def fur_patch(head: Image.Image, box: tuple, size: tuple) -> Image.Image:
    """Patch de fourrure cloné depuis une zone propre du crâne, bruité et flouté."""
    patch = head.convert("RGB").crop(box).resize(size)
    patch = patch.filter(ImageFilter.GaussianBlur(1.2))
    return patch


def erase_ellipse(head: Image.Image, ellipse: tuple, donor: tuple) -> Image.Image:
    """Remplace une ellipse par de la fourrure clonée, bords estompés."""
    cx, cy, rx, ry = ellipse
    x0, y0 = cx - rx, cy - ry
    w, h = rx * 2, ry * 2
    patch = fur_patch(head, donor, (w, h))
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse((0, 0, w - 1, h - 1), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(3))
    head.paste(patch, (x0, y0), mask)
    return head


def reset_face(head: Image.Image) -> Image.Image:
    forehead = (206, 206, 306, 252)  # fourrure sombre du front, sans marques
    head = erase_ellipse(head, (EYE_L[0], EYE_L[1] + 2, EYE_L[2] + 13, EYE_L[3] + 13), forehead)
    head = erase_ellipse(head, (EYE_R[0], EYE_R[1] + 2, EYE_R[2] + 13, EYE_R[3] + 13), forehead)
    head = erase_ellipse(head, (MOUTH[0], MOUTH[1] + 2, 52, 36), forehead)
    return head


def _ey(cx, cy, rx, ry):
    return tuple(v * SS for v in (cx, cy, rx, ry))


def eye_open(d, e):
    cx, cy, rx, ry = _ey(*e)
    lw = 3 * SS
    d.ellipse((cx-rx, cy-ry, cx+rx, cy+ry), fill=AMBER, outline=OUTLINE, width=lw)
    pr = int(rx * 0.66)
    d.ellipse((cx-pr, cy-pr, cx+pr, cy+pr), fill=(16, 10, 8))
    hx, hy = cx - int(rx*0.45), cy - int(ry*0.5)
    hr = int(rx * 0.26)
    d.ellipse((hx-hr, hy-hr, hx+hr, hy+hr), fill=EYE_WHITE)
    sr = int(rx * 0.12)
    sx, sy = cx + int(rx*0.35), cy + int(ry*0.4)
    d.ellipse((sx-sr, sy-sr, sx+sr, sy+sr), fill=(235, 228, 220))


def eye_closed(d, e, up=True):
    cx, cy, rx, ry = _ey(*e)
    h = int(ry * 0.55)
    if up:
        d.arc((cx-rx, cy-h, cx+rx, cy+h+int(ry*0.5)), 180, 360, fill=OUTLINE, width=6*SS)
    else:
        d.arc((cx-rx, cy-h-int(ry*0.5), cx+rx, cy+h), 0, 180, fill=OUTLINE, width=6*SS)


def eye_squint(d, e):
    cx, cy, rx, ry = _ey(*e)
    d.line((cx-rx, cy-int(ry*0.35), cx, cy), fill=OUTLINE, width=6*SS)
    d.line((cx, cy, cx+rx, cy-int(ry*0.35)), fill=OUTLINE, width=6*SS)


def eye_star(d, e):
    cx, cy, rx, ry = _ey(*e)
    pts = []
    for i in range(10):
        r = rx if i % 2 == 0 else int(rx * 0.45)
        a = math.pi / 2 + i * math.pi / 5
        pts.append((cx + r * math.cos(a), cy - r * math.sin(a)))
    d.polygon(pts, fill=STAR, outline=OUTLINE, width=3*SS)


def eye_heart(d, e):
    cx, cy, rx, ry = _ey(*e)
    r = int(rx * 0.55)
    d.ellipse((cx-2*r, cy-1.6*r, cx, cy+0.2*r), fill=HEART)
    d.ellipse((cx, cy-1.6*r, cx+2*r, cy+0.2*r), fill=HEART)
    d.polygon([(cx-1.9*r, cy-0.1*r), (cx+1.9*r, cy-0.1*r), (cx, cy+1.7*r)], fill=HEART)


def eye_half(d, e):
    cx, cy, rx, ry = _ey(*e)
    eye_open(d, (cx, cy + int(ry*0.25), rx, int(ry*0.75)))
    d.rectangle((cx-rx-4*SS, cy-ry-6*SS, cx+rx+4*SS, cy-int(ry*0.15)), fill=FUR_MID)
    d.line((cx-rx, cy-int(ry*0.15), cx+rx, cy-int(ry*0.15)), fill=OUTLINE, width=5*SS)


def eye_rolled(d, e):
    cx, cy, rx, ry = _ey(*e)
    d.ellipse((cx-rx, cy-ry, cx+rx, cy+ry), fill=EYE_WHITE, outline=OUTLINE, width=3*SS)
    pr = int(rx * 0.4)
    d.ellipse((cx-pr, cy-ry+int(ry*0.15), cx+pr, cy+int(ry*0.15)-int(ry*0.5)+pr), fill=OUTLINE)


def eye_line(d, e):
    cx, cy, rx, ry = _ey(*e)
    d.line((cx-rx, cy, cx+rx, cy), fill=OUTLINE, width=6*SS)


def eye_x(d, e):
    cx, cy, rx, ry = _ey(*e)
    r = int(rx * 0.7)
    d.line((cx-r, cy-r, cx+r, cy+r), fill=OUTLINE, width=6*SS)
    d.line((cx+r, cy-r, cx-r, cy+r), fill=OUTLINE, width=6*SS)


def eye_spiral(d, e):
    cx, cy, rx, ry = _ey(*e)
    pts = []
    for i in range(60):
        a = i * 0.42
        r = rx * i / 60
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    d.line(pts, fill=OUTLINE, width=4*SS, joint="curve")


EYES = {
    "open": eye_open, "closed_up": lambda d, e: eye_closed(d, e, True),
    "closed_down": lambda d, e: eye_closed(d, e, False), "squint": eye_squint,
    "star": eye_star, "heart": eye_heart, "half": eye_half, "rolled": eye_rolled,
    "line": eye_line, "x": eye_x, "spiral": eye_spiral,
}


def brow(d, e, kind, side):
    cx, cy, rx, ry = _ey(*e)
    y = cy - ry - int(ry * 0.75)
    inner, outer = (cx + rx, cx - rx) if side == "L" else (cx - rx, cx + rx)
    if kind == "sad":
        d.line((outer, y + int(ry*0.5), inner, y - int(ry*0.25)), fill=OUTLINE, width=6*SS)
    elif kind == "angry":
        d.line((outer, y - int(ry*0.25), inner, y + int(ry*0.65)), fill=OUTLINE, width=6*SS)
    elif kind == "raised":
        d.arc((cx-rx, y-int(ry*0.9), cx+rx, y+int(ry*0.4)), 180, 360, fill=OUTLINE, width=6*SS)


def mouth_smile(d, big=False):
    cx, cy = MOUTH[0]*SS, MOUTH[1]*SS
    w = int((52 if big else 40) * SS)
    h = int((16 if big else 12) * SS)
    d.arc((cx-w, cy-h, cx+w, cy+h+int(14*SS)), 20, 160, fill=OUTLINE, width=6*SS)


def mouth_frown(d):
    cx, cy = MOUTH[0]*SS, (MOUTH[1]+6)*SS
    w, h = int(34*SS), int(14*SS)
    d.arc((cx-w, cy-h, cx+w, cy+h), 200, 340, fill=OUTLINE, width=6*SS)


def mouth_flat(d):
    cx, cy = MOUTH[0]*SS, MOUTH[1]*SS
    w = int(30*SS)
    d.line((cx-w, cy, cx+w, cy), fill=OUTLINE, width=6*SS)


def mouth_wavy(d):
    cx, cy = MOUTH[0]*SS, MOUTH[1]*SS
    pts = [(cx - 30*SS + i*10*SS, cy + (6*SS if i % 2 else -6*SS)) for i in range(7)]
    d.line(pts, fill=OUTLINE, width=5*SS, joint="curve")


def mouth_grin(d, tongue=True):
    cx, cy = MOUTH[0]*SS, (MOUTH[1]+4)*SS
    w, h = int(44*SS), int(26*SS)
    d.pieslice((cx-w, cy-h, cx+w, cy+h), 0, 180, fill=(20, 12, 14), outline=OUTLINE, width=4*SS)
    if tongue:
        d.pieslice((cx-w+int(10*SS), cy-h+int(8*SS), cx+w-int(10*SS), cy+h+int(6*SS)), 20, 160, fill=TONGUE)


def mouth_open_o(d):
    cx, cy = MOUTH[0]*SS, (MOUTH[1]+6)*SS
    rx, ry = int(16*SS), int(20*SS)
    d.ellipse((cx-rx, cy-ry, cx+rx, cy+ry), fill=(20, 12, 14), outline=OUTLINE, width=4*SS)


def mouth_grit(d):
    cx, cy = MOUTH[0]*SS, MOUTH[1]*SS
    w, h = int(34*SS), int(11*SS)
    d.rounded_rectangle((cx-w, cy-h, cx+w, cy+h), radius=int(8*SS),
                        fill=EYE_WHITE, outline=OUTLINE, width=4*SS)
    d.line((cx-w+int(4*SS), cy, cx+w-int(4*SS), cy), fill=OUTLINE, width=3*SS)
    for i in range(-2, 3):
        x = cx + i * int(16*SS)
        d.line((x, cy-h+int(3*SS), x, cy+h-int(3*SS)), fill=OUTLINE, width=2*SS)


def mouth_tongue_out(d):
    mouth_smile(d)
    cx, cy = MOUTH[0]*SS, (MOUTH[1]+10)*SS
    w, h = int(16*SS), int(22*SS)
    d.rounded_rectangle((cx-w, cy, cx+w, cy+h), radius=int(10*SS),
                        fill=TONGUE, outline=OUTLINE, width=3*SS)


def mouth_none(d):
    pass


def mouth_zipper(d):
    cx, cy = MOUTH[0]*SS, MOUTH[1]*SS
    w = int(32*SS)
    d.line((cx-w, cy, cx+w, cy), fill=OUTLINE, width=5*SS)
    for i in range(-3, 4):
        x = cx + i * int(9*SS)
        d.line((x, cy-int(5*SS), x, cy+int(5*SS)), fill=OUTLINE, width=2*SS)


def mouth_kiss(d):
    cx, cy = MOUTH[0]*SS, (MOUTH[1]+4)*SS
    rx, ry = int(12*SS), int(14*SS)
    d.ellipse((cx-rx, cy-ry, cx+rx, cy+ry), outline=OUTLINE, width=5*SS)


MOUTHS = {
    "smile": mouth_smile, "grin_big": lambda d: mouth_grin(d, True),
    "grin": lambda d: mouth_grin(d, False), "frown": mouth_frown,
    "flat": mouth_flat, "wavy": mouth_wavy, "open_o": mouth_open_o,
    "grit": mouth_grit, "tongue_out": mouth_tongue_out,
    "none": mouth_none, "zipper": mouth_zipper, "kiss": mouth_kiss,
}


def drop(d, x, y, r, color, tail_up=True):
    x, y, r = x*SS, y*SS, r*SS
    d.ellipse((x-r, y-r, x+r, y+r), fill=color)
    tip = y - int(r*2.4) if tail_up else y + int(r*2.4)
    d.polygon([(x-int(r*0.85), y-int(r*0.3)), (x+int(r*0.85), y-int(r*0.3)), (x, tip)], fill=color)


def extra_tear(d, spec):
    x, y, r = spec.get("pos", (150, 330)), None, None
    px, py = spec["pos"]
    drop(d, px, py, spec.get("r", 9), TEAR)


def extra_sweat(d, spec):
    px, py = spec["pos"]
    drop(d, px, py, spec.get("r", 10), SWEAT)


def extra_steam(d, spec):
    for dx in (-1, 1):
        x = 255 + dx * spec.get("spread", 36)
        for i in range(3):
            r = 6 - i * 1.5
            d.ellipse(((x - r)*SS, (348 - i*11 - r)*SS, (x + r)*SS, (348 - i*11 + r)*SS),
                      fill=(235, 240, 245))


def extra_zzz(d, spec):
    x, y = spec.get("pos", (400, 170))
    for i, s in enumerate((18, 13, 9)):
        d.text(((x + i*16)*SS, (y - i*20)*SS), "Z", fill=(120, 160, 230),
               font_size=s*SS*2)


def extra_heart(d, spec):
    px, py = spec["pos"]
    r = spec.get("r", 12) * SS
    d.ellipse((px*SS-r, py*SS-r, px*SS, py*SS), fill=HEART)
    d.ellipse((px*SS, py*SS-r, px*SS+r, py*SS), fill=HEART)
    d.polygon([(px*SS-r*0.9, py*SS-r*0.1), (px*SS+r*0.9, py*SS-r*0.1), (px*SS, py*SS+r)], fill=HEART)


def extra_blush(d, spec):
    for px in spec.get("xs", (140, 372)):
        r = spec.get("r", 16) * SS
        y = spec.get("y", 336) * SS
        d.ellipse((px*SS-r, y-int(r*0.5), px*SS+r, y+int(r*0.5)), fill=BLUSH)


def _glasses_frame(d, e, lens=False):
    cx, cy, rx, ry = _ey(*e)
    r = int(rx * 1.12)
    if lens:
        d.line((cx-int(r*0.6), cy+int(r*0.5), cx+int(r*0.2), cy-int(r*0.6)),
               fill=(230, 240, 250), width=4*SS)
        d.line((cx-int(r*0.1), cy+int(r*0.6), cx+int(r*0.55), cy-int(r*0.35)),
               fill=(230, 240, 250), width=3*SS)
    d.ellipse((cx-r, cy-int(r*0.9), cx+r, cy+int(r*1.1)), outline=(196, 182, 150), width=9*SS)


def extra_sunglasses(d, spec):
    for e in (EYE_L, EYE_R):
        cx, cy, rx, ry = _ey(*e)
        r = int(rx * 1.12)
        d.ellipse((cx-r, cy-int(r*0.9), cx+r, cy+int(r*1.1)), fill=(18, 16, 22),
                  outline=(8, 6, 10), width=4*SS)
    d.line((EYE_L[0]*SS + int(EYE_L[2]*1.12*SS), (EYE_L[1]+8)*SS,
            EYE_R[0]*SS - int(EYE_R[2]*1.12*SS), (EYE_R[1]+8)*SS),
           fill=(8, 6, 10), width=4*SS)


def extra_glasses(d, spec):
    _glasses_frame(d, EYE_L)
    _glasses_frame(d, EYE_R)
    d.line((EYE_L[0]*SS + int(EYE_L[2]*SS), EYE_L[1]*SS,
            EYE_R[0]*SS - int(EYE_R[2]*SS), EYE_R[1]*SS), fill=(168, 156, 132), width=3*SS)


def extra_monocle(d, spec):
    _glasses_frame(d, EYE_R, lens=True)
    cx, cy, rx, ry = _ey(*EYE_R)
    d.line((cx+int(rx*0.9), cy+int(ry*1.0), cx+int(rx*1.6), cy+int(ry*2.6)),
           fill=(168, 156, 132), width=3*SS)


def extra_mask(d, spec):
    x0, y0 = 196*SS, 330*SS
    x1, y1 = 316*SS, 404*SS
    d.rounded_rectangle((x0, y0, x1, y1), radius=int(14*SS),
                        fill=MASK_WHITE, outline=(170, 178, 188), width=3*SS)
    for y in (348, 366, 384):
        d.line((x0+int(8*SS), y*SS, x1-int(8*SS), y*SS), fill=(196, 204, 214), width=2*SS)
    d.line((150*SS, 352*SS, x0, y0+int(14*SS)), fill=MASK_WHITE, width=4*SS)
    d.line((x1, y0+int(14*SS), 362*SS, 352*SS), fill=MASK_WHITE, width=4*SS)


def extra_thermometer(d, spec):
    x0, y0 = 292*SS, 372*SS
    d.rounded_rectangle((x0, y0, x0+int(46*SS), y0+int(12*SS)), radius=int(6*SS),
                        fill=(240, 244, 248), outline=(150, 158, 168), width=2*SS)
    d.ellipse((x0+int(40*SS), y0-int(2*SS), x0+int(54*SS), y0+int(14*SS)), fill=(226, 70, 70))


def extra_bandage(d, spec):
    x0, y0 = 210*SS, 214*SS
    d.rounded_rectangle((x0, y0, x0+int(92*SS), y0+int(22*SS)), radius=int(8*SS),
                        fill=(246, 236, 214), outline=(210, 196, 168), width=2*SS)
    for dx in (18, 38, 58):
        d.ellipse((x0+dx*SS, y0+int(8*SS), x0+dx*SS+int(4*SS), y0+int(12*SS)), fill=(214, 150, 150))


def extra_drool(d, spec):
    x, y = 292*SS, 392*SS
    d.polygon([(x, y), (x+int(10*SS), y), (x+int(5*SS), y+int(34*SS))], fill=TEAR)
    d.ellipse((x-int(5*SS), y-int(8*SS), x+int(15*SS), y+int(10*SS)), fill=TEAR)


def extra_symbols(d, spec):
    cx, cy = MOUTH[0]*SS, (MOUTH[1]-2)*SS
    d.rectangle((cx-int(40*SS), cy-int(16*SS), cx+int(40*SS), cy+int(16*SS)),
                fill=OUTLINE)
    for i, dx in enumerate((-24, 0, 24)):
        x = cx + dx*SS
        c = [(240, 200, 60), (220, 90, 60), (120, 200, 120)][i]
        d.line((x-int(7*SS), cy+int(9*SS), x+int(7*SS), cy-int(9*SS)), fill=c, width=4*SS)
        d.line((x+int(7*SS), cy+int(9*SS), x-int(7*SS), cy-int(9*SS)), fill=c, width=4*SS)


def extra_vomit(d, spec):
    x0 = 255*SS
    d.polygon([(x0-int(26*SS), 396*SS), (x0+int(26*SS), 396*SS),
               (x0+int(18*SS), 452*SS), (x0-int(14*SS), 448*SS)],
              fill=(238, 240, 232), outline=(200, 204, 196), width=2*SS)


def extra_paw(d, spec):
    cx, cy = MOUTH[0]*SS, (MOUTH[1]+6)*SS
    r = int(26*SS)
    d.ellipse((cx-r, cy-int(r*0.8), cx+r, cy+int(r*0.8)), fill=(30, 26, 34),
              outline=OUTLINE, width=3*SS)
    for dx in (-14, 0, 14):
        d.ellipse((cx+int(dx*SS)-int(7*SS), cy-int(r*0.75), cx+int(dx*SS)+int(7*SS), cy-int(r*0.3)),
                  fill=(30, 26, 34), outline=OUTLINE, width=2*SS)


def extra_puff(d, spec):
    x, y = 330*SS, 372*SS
    for i, r in enumerate((14, 10, 7)):
        d.ellipse((x+i*int(16*SS)-r, y-r, x+i*int(16*SS)+r, y+r), fill=(226, 232, 238))


def extra_cracks(d, spec):
    for pts in ([(200, 250), (212, 268), (204, 288), (216, 306)],
                [(318, 240), (308, 262), (320, 280), (310, 300)],
                [(250, 210), (258, 228), (248, 244)]):
        d.line([(x*SS, y*SS) for x, y in pts], fill=(224, 222, 228), width=4*SS)


def extra_horns(d, spec):
    for sx in (-1, 1):
        x = 255 + sx * 96
        d.polygon([(x*SS - 16*SS, 200*SS), (x*SS + 16*SS, 200*SS), (x*SS + sx*8*SS, 132*SS)],
                  fill=(180, 60, 66), outline=OUTLINE, width=3*SS)


def extra_halo(d, spec):
    d.ellipse((168*SS, 96*SS, 342*SS, 136*SS), outline=(246, 214, 96), width=7*SS)


def extra_salute(d, spec):
    x, y = 352*SS, 242*SS
    d.ellipse((x-22*SS, y-30*SS, x+22*SS, y+22*SS), fill=(34, 29, 37), outline=OUTLINE, width=3*SS)
    for dx in (-14, 0, 14):
        d.ellipse((x+dx*SS-8*SS, y-40*SS, x+dx*SS+8*SS, y-16*SS),
                  fill=(34, 29, 37), outline=OUTLINE, width=2*SS)


def extra_cloud(d, spec):
    for x, y, r in ((180, 392, 40), (255, 410, 46), (330, 392, 40), (215, 430, 34), (300, 430, 34)):
        d.ellipse(((x-r)*SS, (y-r)*SS, (x+r)*SS, (y+r)*SS), fill=(226, 230, 236))


def extra_long_nose(d, spec):
    d.polygon([(243*SS, 352*SS), (267*SS, 352*SS), (272*SS, 432*SS), (238*SS, 432*SS)],
              fill=(176, 120, 112), outline=OUTLINE, width=3*SS)


def extra_bags(d, spec):
    for cx, cy in ((EYE_L[0], EYE_L[1] + EYE_L[3] + 16), (EYE_R[0], EYE_R[1] + EYE_R[3] + 16)):
        d.arc(((cx-26)*SS, (cy-16)*SS, (cx+26)*SS, (cy+18)*SS), 20, 160,
              fill=(118, 102, 130), width=6*SS)


def extra_explode(d, spec):
    import random as _random
    rnd = _random.Random(7)
    for i in range(9):
        a = math.pi + i * math.pi / 8
        x = 255 + math.cos(a) * 120
        y = 200 + math.sin(a) * 90
        r = rnd.randint(22, 34)
        d.ellipse(((x-r)*SS, (y-r)*SS, (x+r)*SS, (y+r)*SS), fill=(240, 244, 248))
    for i in range(6):
        a = math.pi + 0.3 + i * 0.5
        x = 255 + math.cos(a) * 150
        y = 205 + math.sin(a) * 115
        d.line((x*SS, y*SS, (x + math.cos(a)*22)*SS, (y + math.sin(a)*22)*SS),
               fill=(246, 198, 72), width=4*SS)


def extra_hat(d, spec):
    d.ellipse((150*SS, 178*SS, 360*SS, 214*SS), fill=(150, 104, 62), outline=(96, 64, 38), width=4*SS)
    d.rounded_rectangle((196*SS, 122*SS, 314*SS, 186*SS), radius=14*SS,
                        fill=(166, 116, 70), outline=(96, 64, 38), width=4*SS)
    d.rectangle((196*SS, 168*SS, 314*SS, 182*SS), fill=(118, 80, 46))


def extra_disguise(d, spec):
    _glasses_frame(d, EYE_L)
    _glasses_frame(d, EYE_R)
    d.line((EYE_L[0]*SS + int(EYE_L[2]*SS), EYE_L[1]*SS,
            EYE_R[0]*SS - int(EYE_R[2]*SS), EYE_R[1]*SS), fill=(196, 182, 150), width=4*SS)
    d.ellipse((234*SS, 336*SS, 276*SS, 378*SS), fill=(214, 140, 132), outline=OUTLINE, width=3*SS)
    d.arc((196*SS, 360*SS, 255*SS, 404*SS), 200, 340, fill=(70, 60, 66), width=7*SS)
    d.arc((255*SS, 360*SS, 314*SS, 404*SS), 200, 340, fill=(70, 60, 66), width=7*SS)


def extra_motion(d, spec):
    direction = spec.get("dir", "h")
    for sx in (-1, 1):
        x0 = 255 + sx * 132
        y0 = 262
        for i in range(3):
            off = i * 14
            if direction == "h":
                d.arc(((x0-off-24)*SS, (y0-44)*SS, (x0-off+24)*SS, (y0+44)*SS),
                      300 if sx < 0 else 240, 60 if sx < 0 else 360, fill=(214, 218, 226), width=6*SS)
            else:
                d.arc(((x0-40)*SS, (y0+off-20)*SS, (x0+40)*SS, (y0+off+20)*SS),
                      200, 340, fill=(214, 218, 226), width=6*SS)


def extra_melt(d, spec):
    for x, y0, y1 in ((196, 396, 442), (236, 404, 450), (276, 400, 446), (316, 394, 440)):
        d.rounded_rectangle((x*SS - 7*SS, y0*SS, x*SS + 7*SS, y1*SS), radius=7*SS,
                            fill=(70, 63, 74), outline=(120, 112, 126), width=2*SS)
    d.ellipse((176*SS, 430*SS, 336*SS, 452*SS), fill=(70, 63, 74), outline=(120, 112, 126), width=2*SS)


EXTRAS = {
    "tear": extra_tear, "sweat": extra_sweat, "steam": extra_steam,
    "zzz": extra_zzz, "heart": extra_heart, "blush": extra_blush,
    "sunglasses": extra_sunglasses, "glasses": extra_glasses, "monocle": extra_monocle,
    "mask": extra_mask, "thermometer": extra_thermometer, "bandage": extra_bandage,
    "drool": extra_drool, "symbols": extra_symbols, "vomit": extra_vomit,
    "paw": extra_paw, "puff": extra_puff, "cracks": extra_cracks,
    "horns": extra_horns, "halo": extra_halo, "salute": extra_salute,
    "cloud": extra_cloud, "long_nose": extra_long_nose, "bags": extra_bags,
    "explode": extra_explode, "hat": extra_hat, "disguise": extra_disguise,
    "motion": extra_motion, "melt": extra_melt,
}


def fit_canvas(img: Image.Image, size: int = 512) -> Image.Image:
    bbox = img.getchannel("A").getbbox() or (0, 0, img.width, img.height)
    content = img.crop(bbox)
    scale = min(1.0, size / max(content.width, content.height))
    if scale < 1.0:
        content = content.resize((int(content.width*scale), int(content.height*scale)), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(content, ((size-content.width)//2, (size-content.height)//2))
    return canvas


def render(expr: dict, head_template: Image.Image) -> Image.Image:
    big = head_template.convert("RGBA").resize((512*SS, 512*SS), Image.LANCZOS)
    d = ImageDraw.Draw(big)
    scale = expr.get("eye_scale", 1.0)
    el = (EYE_L[0], EYE_L[1], EYE_L[2]*scale, EYE_L[3]*scale)
    er = (EYE_R[0], EYE_R[1], EYE_R[2]*scale, EYE_R[3]*scale)
    eyes = expr["eyes"]
    if isinstance(eyes, dict):
        EYES[eyes["left"]](d, el); EYES[eyes["right"]](d, er)
    elif eyes == "wink_left":
        eye_closed(d, el, True); eye_open(d, er)
    elif eyes == "wink_right":
        eye_open(d, el); eye_closed(d, er, True)
    else:
        EYES[eyes](d, el); EYES[eyes](d, er)
    brows = expr.get("brows")
    if brows:
        brow(d, el, brows, "L"); brow(d, er, brows, "R")
    MOUTHS[expr["mouth"]](d)
    for ex in expr.get("extras", []):
        EXTRAS[ex["kind"]](d, ex)
    img = big.resize((512, 512), Image.LANCZOS)
    tint = expr.get("tint")
    if tint:
        # Teinte sur la fourrure seulement : pixels sombres (V bas) ET peu
        # saturés (S bas). Yeux ambre, langue, larmes, reflets sont épargnés.
        hsv = img.convert("RGB").convert("HSV")
        v = hsv.getchannel("V").point(lambda p: int(max(0, 90 - p) * 2.2))
        s = hsv.getchannel("S").point(lambda p: int(max(0, 110 - p) * 2.3))
        mask = ImageChops.multiply(v, s)
        mask = ImageChops.multiply(mask, img.getchannel("A"))
        layer = Image.new("RGBA", img.size, (*tint, 255))
        layer.putalpha(mask)
        img = Image.alpha_composite(img, layer)
    if expr.get("dotted"):
        alpha = img.getchannel("A")
        edge = ImageChops.subtract(alpha, alpha.filter(ImageFilter.MinFilter(9)))
        img.putalpha(alpha.point(lambda a: int(a * 0.62)))
        px = edge.load()
        dots = ImageDraw.Draw(img)
        for y in range(0, 512, 6):
            for x in range(0, 512, 6):
                if px[x, y] > 70:
                    dots.ellipse((x-2.5, y-2.5, x+2.5, y+2.5), fill=(242, 246, 252, 255))
    if expr.get("rotate"):
        img = img.rotate(expr["rotate"], expand=True, resample=Image.BICUBIC)
        img = fit_canvas(img)
    return img


def main():
    only = set(sys.argv[1:])
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    head = reset_face(load_head())
    head.save(OUT / "_template.png")
    n = 0
    for expr in spec["expressions"]:
        if only and expr["id"] not in only:
            continue
        img = render(expr, head)
        img.save(OUT / f"{expr['id']}.png")
        print(f"  ✓ {expr['id']}")
        n += 1
    print(f"{n} visages procéduraux → {OUT}")


if __name__ == "__main__":
    main()
