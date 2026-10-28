#!/usr/bin/env python3
"""
Planche de validation visuelle des 12 portraits faciaux MboloChat (étape 1A).

Aucune nouvelle image d'emoji n'est produite : la planche assemble les fichiers
réels du projet sans les modifier. Décision artistique réservée à la revue
humaine sur Android.

Entrées (fichiers réels, non modifiés) :
  assets/emoji-faces/{,large/}<art>.webp            (12 portraits × 2 tailles)
  assets/emoji/<clé>.webp                           (pack générique : repère Unicode)
  scripts/mbolo-emoji-art-map.json                  (correspondances, vérifiées)
  scripts/mbolo-emoji-face-sources.json             (source 2D de chaque visage)
  src/features/emoji/mboloEmojiData.generated.ts    (noms français)

Sorties :
  ../docs/faces-validation/MBOLO-EMOJI-FACES-PLANCHE.png   (comparaison 1:1)
  ../docs/faces-validation/MBOLO-EMOJI-FACES-CONTROLE.png  (tailles réelles simulées)
"""
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent
FACE_DIR = ROOT / "assets" / "emoji-faces"
GENERIC_DIR = ROOT / "assets" / "emoji"
GEN_DATA = ROOT / "src" / "features" / "emoji" / "mboloEmojiData.generated.ts"
OUT_DIR = REPO / "docs" / "faces-validation"

DEJA = Path("/usr/share/fonts/truetype/dejavu")

# Ordre du lot prototype (clé -> artId), aligné sur le manifeste et les tests.
PROTOTYPE = [
    ("1f642", "face-sourire"),
    ("1f602", "face-fou-rire"),
    ("1f62d", "face-chagrin"),
    ("1f61e", "face-tristesse"),
    ("1f620", "face-colere"),
    ("1f62e", "face-surprise"),
    ("1f631", "face-choc"),
    ("1f60d", "face-yeux-en-coeur"),
    ("1f914", "face-reflexion"),
    ("1f633", "face-timidite"),
    ("1f62a", "face-fatigue"),
    ("1f634", "face-endormi"),
]

# Expression attendue pour chaque portrait (critère d'inspection, pas une validation).
EXPRESSIONS = {
    "face-sourire": "Sourire léger et doux ; yeux ouverts paisibles.",
    "face-fou-rire": "Rire franc : yeux plissés, bouche grande ouverte, larmes de rire.",
    "face-chagrin": "Pleurs : yeux fermés, grosses larmes, bouche en ondulation.",
    "face-tristesse": "Tristesse discrète : regard mouillé, larmes au coin des yeux.",
    "face-colere": "Fureur sourde : sourcils froncés, front plissé, museau fermé.",
    "face-surprise": "Étonnement : yeux très ouverts, bouche arrondie en « o ».",
    "face-choc": "Hurlement de peur : oreilles rabattues, yeux écarquillés, bouche très grande.",
    "face-yeux-en-coeur": "Adoration : yeux en cœurs roses, sourire en coin.",
    "face-reflexion": "Réflexion : regard vers le haut, bouche neutre, patte sous le menton.",
    "face-timidite": "Gêne : rougissement, regard fuyant, sourire crispé.",
    "face-fatigue": "Lassitude : paupières tombantes, goutte de sueur, sourire éteint.",
    "face-endormi": "Sommeil : yeux fermés, Zzz au-dessus de la tête, museau posé sur les pattes.",
}

# Couleurs / tailles relevées dans le code de production (simulation).
LIGHT_THEME = {
    "screen": "#EDEDED",
    "theirBubble": "#FFFFFF",
    "mineBubble": "#95EC69",
    "text": "#111111",
    "panelBg": "#FFFFFF",
}
PANEL_COLS = 8          # EmojiPanel COLS
PANEL_CELL = 46         # EmojiPanel CELL_H
PANEL_ICON = 34         # EmojiPanel EMOJI_SIZE (compact : 30)
TAB_ICON = 24           # icône d'onglet du panneau
INLINE_EM = 20          # round(16 * 1,25) dans EmojiText
JUMBO_EM = 42           # round(38 * 1,1), emoji seul (asset 192)
DOUBLE_EM = 35          # round(32 * 1,1), deux emoji seuls
TRIPLE_EM = 31          # round(28 * 1,1), trois emoji seuls
BUBBLE_RADIUS = 6
BUBBLE_PAD_X = 12
BUBBLE_PAD_Y = 10
LINE_H = 21
SHIFT = int(round(INLINE_EM * 0.14))  # INLINE_SHIFT d'EmojiText ≈ 3 px

_NOMS: dict[str, str] = {}
_SOURCES: dict[str, str] = {}


def fonts() -> dict:
    return {
        "title": ImageFont.truetype(str(DEJA / "DejaVuSans-Bold.ttf"), 26),
        "h2": ImageFont.truetype(str(DEJA / "DejaVuSans-Bold.ttf"), 18),
        "name": ImageFont.truetype(str(DEJA / "DejaVuSans-Bold.ttf"), 19),
        "small": ImageFont.truetype(str(DEJA / "DejaVuSans.ttf"), 14),
        "text": ImageFont.truetype(str(DEJA / "DejaVuSans.ttf"), 16),
        "mono": ImageFont.truetype(str(DEJA / "DejaVuSansMono.ttf"), 13),
        "monoS": ImageFont.truetype(str(DEJA / "DejaVuSansMono.ttf"), 12),
    }


def load_data() -> None:
    """Noms français (registre généré) + source 2D (manifeste facial)."""
    text = GEN_DATA.read_text(encoding="utf-8")
    for key, _ in PROTOTYPE:
        match = re.search(rf'key: "{key}", name: "([^"]+)"', text)
        if not match:
            raise SystemExit(f"Nom introuvable dans le registre pour {key}")
        _NOMS[key] = match.group(1)
    manifest = json.loads((ROOT / "scripts" / "mbolo-emoji-face-sources.json").read_text(encoding="utf-8"))
    ArtIds = {art_id for _, art_id in PROTOTYPE}
    for face in manifest:
        if face["id"] in ArtIds:
            _SOURCES[face["id"]] = face["source"]
    missing = ArtIds - set(_SOURCES)
    if missing:
        raise SystemExit(f"Source 2D absente du manifeste : {sorted(missing)}")


_DISPLAY_CACHE: dict[tuple[str, int], Image.Image] = {}


def display(path: Path, size: int) -> Image.Image:
    """Version d'affichage du fichier réel, rééchantillonnée à la taille de rendu (1x)."""
    key = (str(path), size)
    if key not in _DISPLAY_CACHE:
        _DISPLAY_CACHE[key] = Image.open(path).convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)
    return _DISPLAY_CACHE[key]


def paste(img: Image.Image, canvas: Image.Image, xy: tuple[int, int]) -> None:
    canvas.alpha_composite(img.convert("RGBA"), (int(xy[0]), int(xy[1])))


def wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, width: int) -> list[str]:
    words, lines, current = text.split(), [], ""
    for word in words:
        probe = word if not current else f"{current} {word}"
        if draw.textlength(probe, font=font) <= width:
            current = probe
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def build_board(fnt: dict) -> Image.Image:
    COL_W = 800
    CELL_H = 338
    MARGIN = 28
    HEADER_H = 118
    FOOTER_H = 200
    ROWS = 6
    W = MARGIN * 2 + COL_W * 2
    H = HEADER_H + ROWS * CELL_H + FOOTER_H
    canvas = Image.new("RGBA", (W, H), "#FFFFFF")
    draw = ImageDraw.Draw(canvas)

    draw.text((MARGIN, 24), "MboloChat — visages de réaction : planche de comparaison (étape 1)", fill="#111111", font=fnt["title"])
    draw.text(
        (MARGIN, 66),
        "Fichiers réels du projet affichés 1:1 : 192 px (fichier « large », image jumbo) et 96 px (fichier panneau).",
        fill="#444444",
        font=fnt["small"],
    )
    draw.text(
        (MARGIN, 88),
        "Repère Unicode : pack générique du projet (assets/emoji/<clé>.webp). Aucun dessin nouveau — décision artistique réservée à la revue Android.",
        fill="#444444",
        font=fnt["small"],
    )

    for idx, (key, art_id) in enumerate(PROTOTYPE):
        col = idx % 2
        row = idx // 2
        ox = MARGIN + col * COL_W
        oy = HEADER_H + row * CELL_H
        if col == 1:
            draw.line((ox - 18, oy + 8, ox - 18, oy + CELL_H - 8), fill="#E3E3E3", width=2)

        large = Image.open(FACE_DIR / "large" / f"{art_id}.webp").convert("RGBA")
        small = Image.open(FACE_DIR / f"{art_id}.webp").convert("RGBA")
        paste(large, canvas, (ox, oy + 14))
        paste(small, canvas, (ox + (192 - 96) // 2, oy + 14 + 192 + 14))
        draw.text((ox, oy + 322), "96 px (panneau)", fill="#888888", font=fnt["monoS"])

        tx = ox + 192 + 26
        draw.text((tx, oy + 8), _NOMS[key], fill="#111111", font=fnt["name"])
        draw.text((tx, oy + 38), f"clé {key} · U+{key.upper()} · artId {art_id}", fill="#555555", font=fnt["mono"])
        y = oy + 66
        for line in wrap(draw, f"Expression attendue : {EXPRESSIONS[art_id]}", fnt["text"], COL_W - 192 - 26 - 18):
            draw.text((tx, y), line, fill="#333333", font=fnt["text"])
            y += 22
        y += 4
        repere_label = "Repère Unicode (pack générique du projet) :"
        draw.text((tx, y), repere_label, fill="#777777", font=fnt["small"])
        paste(display(GENERIC_DIR / f"{key}.webp", 46), canvas, (tx + draw.textlength(repere_label, font=fnt["small"]) + 10, y - 6))
        y += 56
        draw.text((tx, y), f"Fichier 96 : {art_id}.webp", fill="#666666", font=fnt["monoS"])
        draw.text((tx, y + 18), f"Fichier 192 : large/{art_id}.webp", fill="#666666", font=fnt["monoS"])
        draw.text((tx, y + 36), f"Source 2D : stickers/mbolo-panther-2d/{_SOURCES[art_id]}.png", fill="#666666", font=fnt["monoS"])

    footer_y = HEADER_H + ROWS * CELL_H + 16
    draw.line((MARGIN, footer_y, W - MARGIN, footer_y), fill="#D6D6D6", width=2)
    draw.text((MARGIN, footer_y + 14), "Observations techniques pour la revue (aucune validation artistique)", fill="#111111", font=fnt["h2"])
    notes = (
        "• Règle 1B : contenu = 86 % de la largeur du canevas, bas ancré à 83 %, centrage horizontal — identique pour les 12.",
        "• face-endormi : contenu haut (Zzz + tête couchée + patte) → canevas plus haut part donc tête apparente à 72 % de largeur (au lieu de 86 %) ; Zzz conservés (sémantique de sommeil).",
        "• face-choc : oreilles déployées jusqu'aux limites de la source → plus de marge haute (tête naturellement plus basse dans le carré).",
        "• face-fatigue : la goutte de sueur fait ~12 px source (~0,8 px en icône panneau 34 px) : invisible en inline 20 px — limite de la source 2D, voir compte rendu.",
        "• face-reflexion / face-endormi : patte sous le menton conservée (détail porteur du sens) — à confirmer en revue.",
        "• Aucun dessin nouveau : recadrages, masque polygonal (endormi) et normalisation de composition uniquement.",
    )
    for i, note in enumerate(notes):
        draw.text((MARGIN + 4, footer_y + 46 + i * 22), note, fill="#555555", font=fnt["small"])

    canvas.convert("RGB").save(OUT_DIR / "MBOLO-EMOJI-FACES-PLANCHE.png", "PNG")
    return canvas


def control_sheet(fnt: dict) -> Image.Image:
    PHONE_W = 390
    LEGEND_W = 470
    MARGIN = 24
    TITLE_H = 96
    HEADER_H = 62
    TAB_H = 40
    GRID_ROWS = 2
    GRID_H = GRID_ROWS * PANEL_CELL
    CHAT_MIN = 600
    H = TITLE_H + HEADER_H + TAB_H + GRID_H + 34 + CHAT_MIN + 36
    W = MARGIN + PHONE_W + 40 + LEGEND_W + MARGIN
    canvas = Image.new("RGBA", (W, H), "#FFFFFF")
    draw = ImageDraw.Draw(canvas)

    draw.text((MARGIN, 22), "MboloChat — contrôle des tailles réelles (simulation, étape 1)", fill="#111111", font=fnt["title"])
    draw.text(
        (MARGIN, 62),
        "Composants de production NON modifiés : chiffres extraits d'EmojiPanel.tsx et de MessageText/EmojiText.tsx (thème clair).",
        fill="#555555",
        font=fnt["small"],
    )

    def bubble(x0: int, y0: int, mine: bool, tokens: list[tuple[str, str]], em_scale: tuple[int, bool]) -> int:
        """Dessin d'une bulle Raphael fidèle : jetons texte/emoji inline ou jumbo."""
        em_size, large = em_scale
        has_text = any(kind == "text" for kind, _ in tokens)
        line_h = LINE_H if has_text else em_size
        widths = [
            draw.textlength(value, font=fnt["text"]) if kind == "text" else em_size + 4
            for kind, value in tokens
        ]
        bubble_w = int(sum(widths)) + 2 * BUBBLE_PAD_X
        bubble_h = line_h + 2 * BUBBLE_PAD_Y
        bx = x0 + PHONE_W - 14 - bubble_w if mine else x0 + 14
        by = y0
        draw.rounded_rectangle(
            (bx, by, bx + bubble_w, by + bubble_h), BUBBLE_RADIUS,
            fill=LIGHT_THEME["mineBubble"] if mine else LIGHT_THEME["theirBubble"],
            outline="#C9E8A9" if mine else "#D6D6D6", width=1,
        )
        cx, cy = bx + BUBBLE_PAD_X, by + BUBBLE_PAD_Y
        for (kind, value), width in zip(tokens, widths):
            if kind == "text":
                draw.text((cx, cy), value, fill=LIGHT_THEME["text"], font=fnt["text"])
            else:
                art = dict(PROTOTYPE)[value]
                file = FACE_DIR / ("large" if large else "") / f"{art}.webp"
                img = display(file, em_size)
                top = int(cy + (line_h - em_size) / 2 + SHIFT - 1) if has_text else int(cy)
                paste(img, canvas, (int(cx), top))
            cx += width
        if mine:
            draw.text((bx + bubble_w - 34, by + bubble_h - 17), "✓✓", fill="#445B49", font=fnt["small"])
        return by + bubble_h + 12

    # --- Panneau d'emojis simulé -------------------------------------------------
    x0, y0 = MARGIN, TITLE_H
    draw.rounded_rectangle((x0 - 10, y0 - 10, x0 + PHONE_W + 10, y0 + HEADER_H + TAB_H + GRID_H + 10), 28, outline="#333333", width=3)
    draw.rounded_rectangle((x0, y0, x0 + PHONE_W, y0 + HEADER_H), 0, fill="#F5F5F5", outline="#D6D6D6", width=1)
    draw.rounded_rectangle((x0, y0, x0 + 34, y0 + HEADER_H), 0, fill="#FFFFFF", outline="#DDDDDD", width=1)
    draw.rounded_rectangle((x0 + PHONE_W - 34, y0, x0 + PHONE_W, y0 + HEADER_H), 0, fill="#FFFFFF", outline="#DDDDDD", width=1)
    draw.text((x0 + 52, y0 + 8), "Panneau d'emojis", fill="#111111", font=fnt["name"])
    draw.text((x0 + 52, y0 + 34), "8 colonnes · icône 34 px (96 px à 1x)", fill="#9B9B9B", font=fnt["monoS"])
    draw.line((x0, y0 + HEADER_H, x0 + PHONE_W, y0 + HEADER_H), fill="#D6D6D6", width=1)

    py = y0 + HEADER_H
    tab_x = x0 + 6
    draw.rounded_rectangle((tab_x, py + 3, tab_x + 44, py + 37), 8, fill="#E7F7EC")
    paste(display(FACE_DIR / "face-sourire.webp", TAB_ICON), canvas, (tab_x + 10, py + 8))
    for k in range(1, 8):
        draw.ellipse((tab_x + 44 + 16 * k - 4, py + 16, tab_x + 44 + 16 * k + 4, py + 24), fill="#D9D9D9")
    draw.line((x0, py + TAB_H, x0 + PHONE_W, py + TAB_H), fill="#D6D6D6", width=1)

    panel = Image.new("RGBA", (PHONE_W, GRID_H), LIGHT_THEME["panelBg"])
    pd = ImageDraw.Draw(panel)
    pd.rectangle((0, 0, PHONE_W - 1, GRID_H - 1), outline="#E1E1E1", width=1)
    for i, (_, art) in enumerate(PROTOTYPE):
        r, c = divmod(i, PANEL_COLS)
        cell_w = PHONE_W // PANEL_COLS
        off_x = c * cell_w + (cell_w - PANEL_ICON) // 2
        off_y = r * PANEL_CELL + (PANEL_CELL - PANEL_ICON) // 2
        panel.alpha_composite(display(FACE_DIR / f"{art}.webp", PANEL_ICON), (off_x, off_y))
    canvas.alpha_composite(panel, (x0, py + TAB_H))

    # --- Conversation simulée ----------------------------------------------------
    chat_x = x0
    chat_y = y0 + HEADER_H + TAB_H + GRID_H + 34
    draw.text((MARGIN, chat_y - 26), "Bulles de message", fill="#111111", font=fnt["h2"])
    draw.rounded_rectangle((chat_x, chat_y, chat_x + PHONE_W, chat_y + CHAT_MIN), 12, fill=LIGHT_THEME["screen"], outline="#D6D6D6", width=1)
    draw.rounded_rectangle((chat_x, chat_y, chat_x + PHONE_W, chat_y + 56), 0, fill="#F5F5F5", outline="#D6D6D6", width=1)
    draw.text((chat_x + 52, chat_y + 8), "Amadou", fill="#111111", font=fnt["name"])
    draw.text((chat_x + 52, chat_y + 32), "en ligne · MboloChat", fill="#9B9B9B", font=fnt["monoS"])
    by = chat_y + 66
    by = bubble(chat_x, by, False, [("text", "Tu rentres quand ? "), ("em", "1f642")], (INLINE_EM, False))
    by = bubble(chat_x, by, True, [("text", "Après le boulot, crevé "), ("em", "1f62a"), ("text", "… dodo direct "), ("em", "1f634")], (INLINE_EM, False))
    by = bubble(chat_x, by, False, [("text", "Non mais c'était trop drôle "), ("em", "1f602")], (INLINE_EM, False))
    by = bubble(chat_x, by, True, [("em", "1f602")], (JUMBO_EM, True))
    by = bubble(chat_x, by, True, [("em", "1f602"), ("em", "1f602")], (DOUBLE_EM, True))
    by = bubble(chat_x, by, True, [("em", "1f602"), ("em", "1f602"), ("em", "1f602")], (TRIPLE_EM, True))
    by = bubble(chat_x, by, False, [("text", "Non. "), ("em", "1f631"), ("text", " j'ai cru que la batterie allait mourir "), ("em", "1f62e")], (INLINE_EM, False))
    by = bubble(chat_x, by, True, [("text", "Ok, je réfléchis… "), ("em", "1f914")], (INLINE_EM, False))

    # --- Légende ------------------------------------------------------------------
    lx = MARGIN + PHONE_W + 40
    draw.text((lx, 128), "Tailles exactes issues du code de production", fill="#111111", font=fnt["h2"])
    entries = [
        ("Grille du panneau", "8 colonnes · icône 34 px · cellule 46 px (compact : 7 col / 30 px), fichier 96 px re-éch. 1x"),
        ("Onglets du panneau", "icône 24 px, même fichier 96 px re-éch."),
        ("Emoji dans une bulle", "fontSize 16 × 1,25 = 20 px ; décalage vertical ≈ 3 px (0,14 × 20)"),
        ("Emoji seul (jumbo)", "fontSize 38 × 1,1 = 42 px → fichier 192 px « large »"),
        ("2 emoji seuls", "fontSize 32 × 1,1 = 35 px → fichier 192 px"),
        ("3 emoji seuls", "fontSize 28 × 1,1 = 31 px → fichier 192 px"),
        ("Bulles", "rayon 6 · marges 12×10 · texte #111111 sur lineHeight 21"),
        ("Thème clair", "écran #EDEDED · bulle perso #95EC69 · bulle reçu #FFFFFF"),
    ]
    ly = 168
    for title, desc in entries:
        draw.text((lx, ly), title, fill="#111111", font=fnt["name"])
        desc_lines = wrap(draw, desc, fnt["small"], LEGEND_W - 20)
        for j, line in enumerate(desc_lines):
            draw.text((lx, ly + 24 + j * 18), line, fill="#555555", font=fnt["small"])
        ly += 24 + 18 * len(desc_lines) + 10
    ly += 6
    draw.line((lx, ly, lx + LEGEND_W, ly), fill="#D6D6D6", width=2)
    ly += 12
    draw.text((lx, ly), "Lisibilité à vérifier par visage :", fill="#111111", font=fnt["name"])
    ly += 26
    for item in (
        "• oreilles nettes (pas de micro-détails perdus en 34 px) ;",
        "• museau distinguable (truffe/bouche) en 20 px comme en 34 px ;",
        "• yeux dorés toujours contrastés ;",
        "• expression lisible sans le texte d'étiquette.",
    ):
        for j, line in enumerate(wrap(draw, item, fnt["small"], LEGEND_W - 20)):
            draw.text((lx, ly), line, fill="#555555", font=fnt["small"])
            ly += 20
    ly += 14
    draw.text((lx, ly), "Simulation de rendu : la revue finale se fait sur Android", fill="#B4610E", font=fnt["small"])
    draw.text((lx, ly + 20), "(dérive possible iOS/Android).", fill="#B4610E", font=fnt["small"])

    canvas.convert("RGB").save(OUT_DIR / "MBOLO-EMOJI-FACES-CONTROLE.png", "PNG")
    return canvas


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    load_data()
    fnt = fonts()
    board = build_board(fnt)
    ctrl = control_sheet(fnt)
    print(f"Planche A (comparaison) : {board.width}×{board.height} px -> {OUT_DIR / 'MBOLO-EMOJI-FACES-PLANCHE.png'}")
    print(f"Planche B (contrôle) : {ctrl.width}×{ctrl.height} px -> {OUT_DIR / 'MBOLO-EMOJI-FACES-CONTROLE.png'}")


if __name__ == "__main__":
    main()
