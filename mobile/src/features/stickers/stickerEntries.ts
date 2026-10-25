import {
  findSticker,
  STICKER_PACKS,
  stickerRef,
  type Sticker,
} from './stickerPacks';
import type { PersonalSticker, StickerLibraryState } from './stickerLibrary';
import { searchStickerEntries } from './stickerSearch';

export { searchStickerEntries };

export type CatalogStickerEntry = {
  kind: 'catalog';
  /** Référence envoyée dans le message (`mbolo-panther-2d/amour`). */
  key: string;
  name: string;
  tags: string[];
  sticker: Sticker;
};

export type PersonalStickerEntry = {
  kind: 'personal';
  key: string;
  name: string;
  tags: string[];
  personal: PersonalSticker;
};

export type StickerEntry = CatalogStickerEntry | PersonalStickerEntry;

const PANTHER_TAGS = ['panthère', 'panther', 'mbolo'];

function entryForCatalogSticker(ref: string, sticker: Sticker): CatalogStickerEntry {
  if (sticker.kind === 'image') {
    return {
      kind: 'catalog',
      key: ref,
      name: sticker.name ?? sticker.alt,
      tags: [...PANTHER_TAGS, ...(sticker.tags ?? []), sticker.alt],
      sticker,
    };
  }
  return {
    kind: 'catalog',
    key: ref,
    name: sticker.label,
    tags: [sticker.label],
    sticker,
  };
}

/** Pack panthère visible dans le sélecteur. */
export const CATALOG_STICKERS: CatalogStickerEntry[] = STICKER_PACKS.flatMap((pack) =>
  pack.stickers.map((sticker) =>
    entryForCatalogSticker(stickerRef(pack.id, sticker.id), sticker),
  ),
);

export function personalEntry(sticker: PersonalSticker): PersonalStickerEntry {
  return {
    kind: 'personal',
    key: sticker.id,
    name: sticker.name,
    tags: [sticker.name],
    personal: sticker,
  };
}

/** Résout une référence de catalogue (y compris les anciennes cartes `mbolo/*`). */
export function catalogEntryFromRef(ref: string): CatalogStickerEntry | undefined {
  const sticker = findSticker(ref);
  return sticker ? entryForCatalogSticker(ref, sticker) : undefined;
}

export function entriesForKeys(
  keys: string[],
  state: StickerLibraryState,
): StickerEntry[] {
  const personalById = new Map(state.personal.map((sticker) => [sticker.id, sticker]));
  const out: StickerEntry[] = [];
  for (const key of keys) {
    const personal = personalById.get(key);
    if (personal) {
      out.push(personalEntry(personal));
      continue;
    }
    const catalog = catalogEntryFromRef(key);
    if (catalog) out.push(catalog);
  }
  return out;
}

