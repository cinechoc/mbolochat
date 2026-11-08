/**
 * Disposition « WeChat » des rangées de message.
 *
 * Contrairement à la conversation classique (avatar uniquement pour les
 * messages reçus), chaque message porte l'avatar de son expéditeur :
 *
 * - reçu  : avatar à gauche, bulle à droite de l'avatar (alignée à gauche) ;
 * - envoyé : bulle à gauche, avatar à droite (bulle alignée à droite) ;
 * - messages consécutifs du même expéditeur : l'avatar n'est pas répété, mais
 *   sa place est **réservée** pour que les bulles restent alignées.
 *
 * Les valeurs renvoyées sont des noms de propriétés `alignItems`/côté, jamais
 * des nombres : la fonction reste pure et testable sans React Native.
 */

export type RowSide = 'left' | 'right';

export type MessageRowLayout = {
  /** Côté où dessiner l'avatar, ou `none` pour un message de continuation. */
  avatar: RowSide | 'none';
  /** Côté où réserver la largeur de l'avatar quand il n'est pas dessiné. */
  spacer: RowSide | 'none';
  /** Alignement de la bulle dans sa colonne. */
  align: 'flex-start' | 'flex-end';
  /** Ordre des enfants : la bulle avant ou après l'avatar. */
  bubbleFirst: boolean;
};

export function messageRowLayout(mine: boolean, continuation: boolean): MessageRowLayout {
  if (mine) {
    return {
      avatar: continuation ? 'none' : 'right',
      spacer: continuation ? 'right' : 'none',
      align: 'flex-end',
      bubbleFirst: true,
    };
  }
  return {
    avatar: continuation ? 'none' : 'left',
    spacer: continuation ? 'left' : 'none',
    align: 'flex-start',
    bubbleFirst: false,
  };
}

/** Largeur de la pastille d'avatar dans les rangées (identique à l'ancien écran). */
export const ROW_AVATAR_SIZE = 40;

/**
 * Largeur maximale d'une bulle, avatar compris.
 *
 * L'ancienne règle (70 % de l'écran) ignorait la place de l'avatar : sur un
 * écran étroit, une bulle longue + l'avatar dépassaient la largeur utile. On
 * garde 70 % comme cible, bornée par la largeur réellement disponible, sans
 * jamais descendre sous un minimum lisible — la bulle reste donc confortable
 * sur les grands écrans et utilisable sur les petits.
 */
export function bubbleMaxWidth(input: {
  windowWidth: number;
  horizontalPadding: number;
  avatarSize?: number;
  gap?: number;
  ratio?: number;
  minWidth?: number;
}): number {
  const {
    windowWidth,
    horizontalPadding,
    avatarSize = ROW_AVATAR_SIZE,
    gap = 8,
    ratio = 0.7,
    minWidth = 160,
  } = input;
  const available = Math.max(0, windowWidth - 2 * horizontalPadding - avatarSize - gap);
  const target = Math.min(Math.round(windowWidth * ratio), available);
  return Math.max(Math.min(minWidth, available), target);
}
