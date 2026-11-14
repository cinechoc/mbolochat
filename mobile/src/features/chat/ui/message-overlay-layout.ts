export interface OverlayAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloatingBarPlacement {
  left: number;
  top: number;
}

export interface FloatingBarPlacementInput {
  anchor: OverlayAnchor | null;
  windowWidth: number;
  windowHeight: number;
  safeTop: number;
  barWidth: number;
  barHeight: number;
  gutter?: number;
  gap?: number;
  /** Bord supérieur du menu bas ; la barre reste au-dessus. */
  menuTop?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Place la barre de réactions au-dessus de la bulle, centrée sur elle. Si la
 * bulle touche le haut de l’écran, la barre passe juste dessous pour rester
 * visible. Les bords sont bornés à la zone utile.
 */
export function placeFloatingBar({
  anchor,
  windowWidth,
  windowHeight,
  safeTop,
  barWidth,
  barHeight,
  gutter = 8,
  gap = 8,
  menuTop,
}: FloatingBarPlacementInput): FloatingBarPlacement {
  const fallback: OverlayAnchor = {
    x: windowWidth / 2,
    y: windowHeight * 0.45,
    width: 0,
    height: 0,
  };
  const target = anchor ?? fallback;
  const maxLeft = Math.max(gutter, windowWidth - barWidth - gutter);
  const left = clamp(target.x + target.width / 2 - barWidth / 2, gutter, maxLeft);
  const above = target.y - barHeight - gap;
  const below = target.y + target.height + gap;
  const minTop = safeTop + gutter;
  const maxTop = Math.max(
    minTop,
    menuTop === undefined
      ? windowHeight - barHeight - gutter
      : Math.min(windowHeight - barHeight - gutter, menuTop - barHeight - gap),
  );
  const preferred = above >= minTop ? above : below;
  const top = Math.min(Math.max(preferred, minTop), maxTop);
  return { left: Math.round(left), top: Math.round(top) };
}
