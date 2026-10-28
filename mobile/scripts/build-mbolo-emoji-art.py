#!/usr/bin/env python3
"""
Optimise les 30 stickers panthère 2D en assets d'emoji MboloChat.

Sorties :
  assets/mbolo-emoji/<id>.webp        (96 px, affichage en ligne / panneau)
  assets/mbolo-emoji/large/<id>.webp  (192 px, emoji envoyé seul)

Les fichiers sont dérivés des illustrations 2D existantes (aucune nouvelle
illustration) : cadrage sur le personnage, marge transparente régulière,
puis WebP avec alpha.
"""
from pathlib import Path
import re
import sys

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "stickers" / "mbolo-panther-2d"
OUT = ROOT / "assets" / "mbolo-emoji"
LARGE = OUT / "large"
ASSETS_TS = ROOT / "src" / "features" / "stickers" / "panther2dAssets.generated.ts"

SMALL_SIZE = 96
LARGE_SIZE = 192
PADDING = 0.05


def ids() -> list[str]:
    text = ASSETS_TS.read_text(encoding="utf-8")
    found = re.findall(r"'([a-z0-9-]+)': require", text)
    if not found:
        raise SystemExit("Aucun sticker panthère trouvé dans panther2dAssets.generated.ts")
    return found


def square_with_margin(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    bbox = rgba.getchannel("A").getbbox()
    if bbox:
        rgba = rgba.crop(bbox)
    side = max(rgba.width, rgba.height)
    side = max(1, int(round(side * (1 + PADDING * 2))))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(rgba, ((side - rgba.width) // 2, (side - rgba.height) // 2))
    return canvas


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    LARGE.mkdir(parents=True, exist_ok=True)
    total = 0
    for sticker_id in ids():
        source = SRC / f"{sticker_id}.png"
        if not source.exists():
            raise SystemExit(f"Sticker manquant : {source}")
        image = square_with_margin(Image.open(source))
        for size, target in (
            (SMALL_SIZE, OUT / f"{sticker_id}.webp"),
            (LARGE_SIZE, LARGE / f"{sticker_id}.webp"),
        ):
            resized = image.resize((size, size), Image.Resampling.LANCZOS)
            resized.save(target, "WEBP", quality=84 if size == SMALL_SIZE else 88, method=6)
            total += target.stat().st_size
        print(f"{sticker_id}: 96 + 192 px")
    print(f"Terminé : {len(ids())} illustrations, {total / 1024:.0f} Ko au total")


if __name__ == "__main__":
    try:
        main()
    except ModuleNotFoundError as exc:
        print(f"Dépendance manquante : {exc}. Installe Pillow (python3 -m pip install pillow).", file=sys.stderr)
        raise SystemExit(1)
