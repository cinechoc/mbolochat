/** Décale la fenêtre de la forme d'onde live d'un niveau, sans dépasser `bars`. */
export function pushLiveLevel(levels: number[], level: number, bars: number): number[] {
  return [...levels.slice(-(bars - 1)), level];
}
