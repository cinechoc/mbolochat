#!/usr/bin/env python3
"""
Prototype d'emojis de réaction faciale MboloChat (étape 1B).

Les assets sont des portraits tête seule, découpés dans les illustrations 2D
panthère existantes : le corps, les pattes et les accessoires flottants sont
retirés. Les stickers complets ne sont ni modifiés ni utilisés directement
comme emojis faciaux.

Étape 1B : cadrage homogène. Chaque contenu (tête + socle de cou, ou détail
expressif validé : larmes, goutte de sueur, patte sous le menton, Zzz) est
composé sur un canevas carré commun :
  - largeur du contenu = 86 % du canevas (86 % horizontaux) ;
  - bas du contenu ancré à 83 % de la hauteur ;
  - centrage horizontal (marges latérales régulières).

Sorties :
  assets/emoji-faces/<id>.webp        (96 px)
  assets/emoji-faces/large/<id>.webp  (192 px)
"""
import json
import math
from pathlib import Path
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "stickers" / "mbolo-panther-2d"
OUT = ROOT / "assets" / "emoji-faces"
LARGE = OUT / "large"
MANIFEST = ROOT / "scripts" / "mbolo-emoji-face-sources.json"

CROP = (30, 0, 482, 288)
SMALL_SIZE = 96
LARGE_SIZE = 192

# Cadrage normalisé (étape 1B) : largeur apparente cible et ancrages communs.
TARGET_W = 0.86      # largeur du contenu = 86 % du canevas
TOP_FLOOR = 0.02     # marge haute minimale si le contenu est haut
BOTTOM_ANCHOR = 0.83  # bas du contenu à 83 % de la hauteur

# Accessoires/particularités par expression. filter_body=False conserve les
# larmes séparées (fou-rire, chagrin) ou la goutte de sueur (fatigue, collée
# au front). "crop" adapte le cadrage quand la tête sort du recadrage standard ;
# "taper": False conserve le bas tel quel (tête couchée).
OPTIONS = {
    "face-fou-rire": {"filter_body": False},
    "face-chagrin": {"filter_body": False},
    "face-timidite": {"remove_blue": True, "cover": (161, 163, 16)},
    "face-fatigue": {"filter_body": False},
    "face-choc": {"crop": (0, 0, 512, 296)},  # oreilles larges : cadre étendu
    "face-endormi": {
        # Tête couchée de sommeil.png : recadrage large puis masque polygonal
        # qui suit la tête (oreilles, museau, patte sous le menton) et les
        # Zzz flottants au-dessus ; le corps (flanc, cuisse, queue) est retiré.
        # filter_body=False : l'isolation des composantes supprimerait les Zzz,
        # le masque polygonal retire le corps.
        "filter_body": False,
        "source_crop": (0, 60, 320, 430),
        "taper": False,
        "clip": {
            "polygon": [
                (28, 241), (20, 257), (20, 273), (22, 281), (26, 289),
                (30, 297), (37, 305), (46, 313), (65, 321), (73, 329),
                (73, 345), (78, 361), (80, 377), (78, 393), (80, 401),
                (96, 409), (128, 413), (150, 414), (212, 414), (226, 404),
                (234, 392), (238, 370), (246, 350), (257, 330), (266, 312),
                (272, 296), (277, 292), (290, 268), (294, 250), (300, 238),
                (304, 228), (312, 222), (314, 205), (314, 180), (300, 150),
                (240, 146), (205, 141), (150, 143), (118, 150), (100, 164),
                (122, 177),
            ],
            "feather": 2.2,
            # Détails exprimatifs hors du polygone, intégralement conservés :
            # les « Zzz » du sommeil (sémantique de 1f634).
            "rect_zones": [(170, 76, 280, 160)],
        },
    },
    # bisous (1f618) : tête penchée, œil fermé, langue, patte sous le menton.
    # filter_body=False conserve le petit cœur flottant (sémantique du bisou,
    # coordonnées mesurées : x 51-101, y 224-274). Le corps est coupé par le
    # recadrage puis fondu ; fondu démarré plus bas : menton/patte plus bas que
    # le cadrage standard.
    "face-bisous": {"filter_body": False, "source_crop": (30, 0, 482, 318),
                    "taper_start": 250, "taper_span": 68},
    # fete (1f973) : chapeau de fête branché sur la tête + sourire ouvert.
    # filter_body=True retire les confettis flottants ; taper=False + masque
    # polygonal épousant tête + chapeau : pattes levées (montent à y≈264,
    # mesuré) et corps retirés alors qu'ils chevauchent la hauteur du menton.
    # Coordonnées issues des profils alpha mesurés (bords de joues : y180→104/400,
    # y246→139/374 source) ; menton ~y 365, recadrage étendu à 368.
    "face-fete": {
        "filter_body": True,
        "source_crop": (10, 0, 512, 368),
        "taper": False,
        "clip": {
            "polygon": [
                (106, 178), (104, 124), (150, 104), (222, 30), (232, 22),
                (322, 22), (332, 30), (348, 108), (398, 168), (402, 178),
                (392, 208), (374, 248), (368, 266), (354, 296), (336, 324),
                (306, 348), (268, 362), (230, 364), (200, 356), (172, 338),
                (150, 308), (134, 272), (126, 238), (112, 200),
            ],
            "feather": 2.4,
        },
    },
    # confusion (1f615) : tête penchée, œil plissé, patte au menton et
    # point(s) d'interrogation flottants (sémantique de la confusion).
    # filter_body=False les conserve ; le corps est encastré par le recadrage
    # puis fondu, ancré bas pour garder la patte sous le menton.
    "face-confusion": {"filter_body": False, "source_crop": (15, 0, 512, 344),
                       "taper_start": 285, "taper_span": 59},

    # ---- Vague 2 — planche reference.JPG (grille 4×4, cellules de 512 px) ----
    # Chaque cellule porte une étiquette de texte en haut (y ≤ ~139) : hors
    # recadrage, et de toute façon composante séparée retirée par filter_body.
    # Règle du fondu : span = hauteur recadrée - start (coupe pleine au bord).

    # fier (réf.) → 😊 1f60a : sourire doux, yeux rieurs ; étiquette et
    # étincelles flottantes retirées par filter_body, queue (reliée en bas à
    # gauche) par le polygone.
    "face-yeux-rieurs": {
        "filter_body": True,
        "source_crop": (40, 120, 480, 470),
        "taper_start": 275, "taper_span": 75,
        "clip": {
            "polygon": [
                (62, 300), (100, 330), (138, 345), (155, 365), (160, 462),
                (356, 465), (400, 340), (415, 260), (360, 150), (250, 125),
                (140, 150), (60, 190),
            ],
            "feather": 2.4,
        },
    },
    # pardon (réf.) → 😅 1f605 : gouttes de sueur sémantiques collées aux
    # joues : filter_body=False les conserve. Texte exclu par y0 (lettres
    # ≤ y 139) ; gouttes au-dessus du fondu (y recadré ≤ 130 < start 260).
    "face-pardon": {
        "filter_body": False,
        "source_crop": (40, 140, 490, 470),
        "taper_start": 260, "taper_span": 70,
    },
    # wow (réf.) → 😲 1f632 : bouche grande ouverte ; « ! » flottant retiré
    # par filter_body, queue (reliée en bas à droite) par le polygone.
    "face-stupefait": {
        "filter_body": True,
        "source_crop": (55, 150, 470, 505),
        "taper_start": 295, "taper_span": 60,
        "clip": {
            "polygon": [
                (65, 300), (95, 400), (140, 505), (345, 505), (348, 420),
                (380, 390), (399, 355), (400, 300), (400, 240), (360, 145),
                (250, 120), (140, 145), (65, 190),
            ],
            "feather": 2.4,
        },
    },
    # fatigue (réf.) → 🥱 1f971 : bâillement ; lune/Zzz flottants retirés
    # (🥱 n'en porte pas).
    "face-baillement": {
        "filter_body": True,
        "source_crop": (75, 150, 505, 500),
        "taper_start": 290, "taper_span": 60,
    },
    # quoi (réf.) → 🤨 1f928 : sourcil levé ; les « ? » flottants sont accolés
    # aux oreilles (incoupables sans les trancher) : retirés, l'expression et
    # la patte à la joue (reliée à la tête) portent le sens.
    "face-quoi": {
        "filter_body": True,
        "source_crop": (55, 125, 478, 440),
        "taper_start": 265, "taper_span": 50,
    },
    # miam (réf.) → 😋 1f60b : langue gourmande ; le donut, relié à la joue,
    # est retiré au polygone le long de sa limite gauche (la langue, plus à
    # gauche, est conservée) ; le bras qui le tient est coupé avec.
    "face-miam": {
        "filter_body": True,
        "source_crop": (45, 140, 392, 490),
        "taper_start": 295, "taper_span": 55,
        "clip": {
            "polygon": [
                (60, 150), (200, 138), (360, 140), (400, 210), (386, 258),
                (350, 296), (334, 340), (332, 370), (340, 395), (350, 420),
                (342, 455), (326, 490), (170, 492), (157, 470), (155, 424),
                (100, 415), (60, 400), (46, 300),
            ],
            "feather": 2.4,
        },
    },
    # grrr (réf.) → 😡 1f621 : rage ; marque de colère flottante retirée.
    "face-grrr": {
        "filter_body": True,
        "source_crop": (60, 150, 420, 505),
        "taper_start": 295, "taper_span": 60,
    },
    # bof (réf.) → 😒 1f612 : regard plissé méprisant ; nuage gribouillis
    # flottant retiré ; artefact x ≤ 33 exclu par x0.
    "face-bof": {
        "filter_body": True,
        "source_crop": (60, 160, 445, 505),
        "taper_start": 285, "taper_span": 60,
    },
    # bisou (réf.) → 😗 1f617 : lèvres pincées ; bulle-cœur (reliée à droite,
    # x ≥ 368) et queue (reliée à gauche, fusionnée à la joue) retirées au
    # polygone ; blush des joues (x ≤ ~365) conservé ; texte exclu par y0.
    "face-bisou-leger": {
        "filter_body": True,
        "source_crop": (30, 138, 470, 505),
        "taper_start": 307, "taper_span": 60,
        "clip": {
            "polygon": [
                (128, 190), (250, 140), (355, 145), (400, 148), (414, 185),
                (412, 212), (400, 238), (366, 256), (368, 270), (368, 320),
                (348, 332), (334, 340), (334, 350), (352, 356), (348, 368),
                (345, 385), (340, 415), (335, 450), (335, 505), (145, 505),
                (140, 420), (108, 400), (100, 365), (108, 330), (112, 260),
                (120, 205),
            ],
            "feather": 2.0,
        },
    },
    # chill (réf.) → 😌 1f60c : tête inclinée, yeux mi-clos sereins. Type
    # face-endormi : filter_body retire le nuage de pensée flottant, le
    # masque polygonal retire coussin, queue et bosse du corps (reliés).
    "face-chill": {
        "filter_body": True,
        "source_crop": (30, 140, 470, 440),
        "taper": False,
        "clip": {
            "polygon": [
                (170, 180), (240, 148), (330, 158), (366, 200), (368, 250),
                (370, 300), (362, 338), (335, 365), (295, 385), (235, 392),
                (165, 387), (105, 372), (78, 348), (63, 302), (68, 250),
                (98, 213), (138, 197),
            ],
            "feather": 2.6,
        },
    },
    # calin (réf.) → 🤗 1f917 : bras et pattes levées autour du visage
    # (exception tête+patte validée) ; étincelles flottantes retirées.
    "face-calin-ouvert": {
        "filter_body": True,
        "source_crop": (20, 128, 490, 472),
        "taper_start": 272, "taper_span": 72,
    },
}
# Visages procéduraux (build-mbolo-emoji-proc.py) : géométrie identique pour
# tous (socle wow.png). Le polygone retire la queue reliée à droite du corps ;
# le corps sous le menton est coupé par le recadrage. filter_body=False : les
# larmes/cœurs/sueur/vapeur flottants sont sémantiques et doivent survivre.
PROC_DEFAULT = {
    "filter_body": False,
    "source_crop": (85, 130, 435, 452),
    "taper": False,
    "clip": {
        "polygon": [
            (112, 205), (128, 158), (160, 185), (200, 152), (255, 140),
            (310, 150), (350, 180), (388, 155), (402, 200), (415, 260),
            (412, 320), (398, 372), (386, 395), (352, 425), (300, 445),
            (255, 450), (210, 445), (160, 420), (120, 380), (100, 320),
            (98, 260),
        ],
        "feather": 2.2,
    },
}

def isolate_main(image: Image.Image) -> Image.Image:
    """Garde le composant opaque principal (tête + corps), pas les accessoires."""
    alpha = image.getchannel("A")
    binary = alpha.point(lambda value: 255 if value > 8 else 0).convert("RGB")
    ImageDraw.floodfill(binary, (256, 200), (128, 128, 128), thresh=0)
    keep = binary.getchannel("R").point(lambda value: 255 if value == 128 else 0)
    out = image.copy()
    out.putalpha(Image.composite(alpha, Image.new("L", image.size, 0), keep))
    return out


def taper_bottom(alpha: Image.Image, width: int, height: int,
                 start: int = 240, span: int = 48) -> Image.Image:
    """Coupe les épaules/corps sous le menton en gardant le centre du visage.

    start/span : début et durée du fondu (le carré du ratio Large™ suit les
    coordonnées sources, donc dépend du recadrage de chaque tête).
    """
    span = max(1, span)
    out = alpha.copy()
    pixels = out.load()
    for y in range(height):
        if y <= start:
            continue
        ratio = (y - start) / span
        cut = int(120 * ratio * ratio)
        for x in range(width):
            if x < cut or x >= width - cut:
                pixels[x, y] = 0
    return out


def apply_clip(image: Image.Image, clip: dict, crop_box: tuple) -> Image.Image:
    """Ne conserve le contenu que dans un polygone (coords source) adouci,
    plus d'éventuelles zones rectangulaires intègres (détails exprimatifs)."""
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).polygon(
        [(x - crop_box[0], y - crop_box[1]) for x, y in clip["polygon"]],
        fill=255,
    )
    mask = mask.filter(ImageFilter.GaussianBlur(clip.get("feather", 2.0)))
    for zone in clip.get("rect_zones", []):
        zimg = Image.new("L", image.size, 0)
        zpx = zimg.load()
        binpx = image.getchannel("A").point(lambda value: 255 if value > 8 else 0).load()
        for y in range(zone[1] - crop_box[1], zone[3] - crop_box[1]):
            for x in range(zone[0] - crop_box[0], zone[2] - crop_box[0]):
                if 0 <= x < image.width and 0 <= y < image.height and binpx[x, y]:
                    zpx[x, y] = 255
        zimg = zimg.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(1.5))
        mask = ImageChops.lighter(mask, zimg)
    out = image.copy()
    out.putalpha(ImageChops.multiply(image.getchannel("A"), mask))
    return out


def normalize(cropped: Image.Image) -> Image.Image:
    """Cadrage commun : contenu sur canevas carré, 86 % de largeur, bas à 83 %.

    La largeur apparente de la tête (accessoire expressif compris) devient
    homogène d'un visage à l'autre ; si le contenu est haut (endormi avec Zzz),
    le canevas s'élargit plutôt que de couper la tête.
    """
    bbox = cropped.getchannel("A").getbbox()
    if bbox is None:
        raise SystemExit("contenu vide : vérifier les options de cadrage")
    content = cropped.crop(bbox)  # tout pixel hors bbox a une alpha nulle
    w, h = content.width, content.height
    side = max(math.ceil(w / TARGET_W), math.ceil(h / (BOTTOM_ANCHOR - TOP_FLOOR)))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    dx = (side - w) // 2
    dy = int(round(BOTTOM_ANCHOR * side)) - h
    canvas.alpha_composite(content, (dx, dy))
    print(
        f"    cadrage : canevas {side}px, largeur {w / side * 100:.0f} %, "
        f"bas {(dy + h) / side * 100:.0f} %, haut {dy / side * 100:.0f} %"
    )
    return canvas


def main() -> None:
    faces = json.loads(MANIFEST.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    LARGE.mkdir(parents=True, exist_ok=True)
    total = 0
    for face in faces:
        options = OPTIONS.get(face["id"])
        if options is None and face.get("dir") == "assets/emoji-faces-proc":
            options = PROC_DEFAULT
        options = options or {}
        source = ROOT / face.get("dir", "assets/stickers/mbolo-panther-2d") / f"{face['source']}.png"
        if not source.exists():
            raise SystemExit(f"Source manquante : {source}")
        image = Image.open(source).convert("RGBA")
        if options.get("filter_body", True):
            image = isolate_main(image)
        if options.get("remove_blue"):
            pixels = image.load()
            for y in range(image.height):
                for x in range(image.width):
                    r, g, b, a = pixels[x, y]
                    if a > 8 and b > r + 35 and b > g + 15:
                        pixels[x, y] = (r, g, b, 0)
        cover = options.get("cover")
        if cover:
            x, y, radius = cover
            fur = image.getpixel((140, 160))[:3]
            ImageDraw.Draw(image).ellipse(
                (x - radius, y - radius, x + radius, y + radius),
                fill=(*fur, 255),
            )

        crop_box = options.get("source_crop", CROP)
        cropped = image.crop(crop_box)
        if options.get("corner_fade"):
            fade_x, fade_y = options["corner_fade"]
            # Coordonnées du fondu exprimées dans l'espace source :
            # conversion en espace recadrage.
            fade_x -= crop_box[0]
            fade_y -= crop_box[1]
            alpha = cropped.getchannel("A").copy()
            pixels = alpha.load()
            for y in range(cropped.height):
                for x in range(cropped.width):
                    if x < fade_x or y < fade_y:
                        continue
                    fx = min(1.0, (x - fade_x) / (cropped.width - fade_x))
                    fy = min(1.0, (y - fade_y) / (cropped.height - fade_y))
                    factor = fx * fy
                    if factor > 0:
                        pixels[x, y] = int(pixels[x, y] * (1 - factor))
            cropped.putalpha(alpha)
        elif options.get("taper", True):
            alpha = taper_bottom(
                cropped.getchannel("A"),
                cropped.width,
                cropped.height,
                start=options.get("taper_start", 240),
                span=options.get("taper_span", 48),
            )
            cropped.putalpha(alpha)

        if options.get("clip"):
            cropped = apply_clip(cropped, options["clip"], crop_box)
        normalized = normalize(cropped)
        for size, target in (
            (SMALL_SIZE, OUT / f"{face['id']}.webp"),
            (LARGE_SIZE, LARGE / f"{face['id']}.webp"),
        ):
            resized = normalized.resize((size, size), Image.Resampling.LANCZOS)
            resized.save(target, "WEBP", quality=84 if size == SMALL_SIZE else 88, method=6)
            total += target.stat().st_size
        print(f"{face['id']} <- {face['source']}")
    print(f"Terminé : {len(faces)} visages, {total / 1024:.0f} Ko au total")


if __name__ == "__main__":
    try:
        main()
    except ModuleNotFoundError as exc:
        print(f"Dépendance manquante : {exc}. Installe Pillow.", file=sys.stderr)
        raise SystemExit(1)
