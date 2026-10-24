import type { Message } from '@/lib/types';

/** Deux fichiers choisis dans la même lancée restent dans le même album. */
export const ALBUM_GAP_MS = 15_000;
export const ALBUM_MAX_TILES = 9;
export const ALBUM_TILE_GAP = 2;

/**
 * Un média entre dans un album s'il est nu : ni légende ni réponse. Un texte
 * existant ne doit jamais disparaître parce que deux photos se suivent.
 */
export function isAlbumPart(message: Message): boolean {
  if (message.deleted || message.replyTo || message.content.length > 0) {
    return false;
  }
  const type = message.attachment?.type;
  return type === 'IMAGE' || type === 'VIDEO';
}

export interface MessageCluster {
  messages: Message[];
  firstAt: number;
  lastAt: number;
}

/**
 * Fusionne les médias consécutifs d'un même expéditeur, à moins de 15 s et
 * dans la limite de 9 tuiles. Tout autre message coupe le groupe.
 */
export function clusterMessages(
  messages: Message[],
  timeOf: (message: Message) => number,
): MessageCluster[] {
  const clusters: MessageCluster[] = [];
  let current: MessageCluster | null = null;

  const flush = () => {
    if (current) {
      clusters.push(current);
      current = null;
    }
  };

  for (const message of messages) {
    const at = timeOf(message);
    if (!isAlbumPart(message)) {
      flush();
      clusters.push({ messages: [message], firstAt: at, lastAt: at });
      continue;
    }
    if (
      current &&
      current.messages[0].sender.id === message.sender.id &&
      current.messages.length < ALBUM_MAX_TILES &&
      at - current.lastAt <= ALBUM_GAP_MS
    ) {
      current.messages.push(message);
      current.lastAt = at;
      continue;
    }
    flush();
    current = { messages: [message], firstAt: at, lastAt: at };
  }
  flush();
  return clusters;
}

export interface AlbumGridTile {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AlbumGridLayout {
  width: number;
  height: number;
  tiles: AlbumGridTile[];
  /** Tuiles réellement dessinées (4 au plus pour la grille 2×2). */
  visible: number;
  /** Fichiers au-delà des quatre tuiles, signalés par « +N ». */
  overflow: number;
}

export function albumGridWidth(windowWidth: number): number {
  return Math.min(Math.round(windowWidth * 0.7), 320);
}

/**
 * Disposition WhatsApp : 2 côte à côte, 3 avec une grande tuile à gauche,
 * 4 et plus en 2×2. Les trous de 2 px sont inclus dans chaque position.
 */
export function albumGridLayout(count: number, width: number): AlbumGridLayout {
  const gap = ALBUM_TILE_GAP;
  const tiles: AlbumGridTile[] = [];

  if (count <= 2) {
    const tile = (width - gap) / 2;
    tiles.push({ x: 0, y: 0, width: tile, height: tile });
    tiles.push({ x: tile + gap, y: 0, width: tile, height: tile });
    return { width, height: tile, tiles: tiles.slice(0, count), visible: count, overflow: 0 };
  }

  if (count === 3) {
    const leftWidth = Math.round((width - gap) * 0.66);
    const rightWidth = width - gap - leftWidth;
    const rightHeight = (width - gap) / 2;
    tiles.push({ x: 0, y: 0, width: leftWidth, height: width });
    tiles.push({ x: leftWidth + gap, y: 0, width: rightWidth, height: rightHeight });
    tiles.push({
      x: leftWidth + gap,
      y: rightHeight + gap,
      width: rightWidth,
      height: rightHeight,
    });
    return { width, height: width, tiles, visible: 3, overflow: 0 };
  }

  const tile = (width - gap) / 2;
  tiles.push({ x: 0, y: 0, width: tile, height: tile });
  tiles.push({ x: tile + gap, y: 0, width: tile, height: tile });
  tiles.push({ x: 0, y: tile + gap, width: tile, height: tile });
  tiles.push({ x: tile + gap, y: tile + gap, width: tile, height: tile });
  return {
    width,
    height: tile * 2 + gap,
    tiles,
    visible: 4,
    overflow: Math.max(0, count - 4),
  };
}
