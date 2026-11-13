/**
 * Signatures binaires des formats d'image acceptés pour les avatars et les
 * photos de groupe : JPEG, PNG, WebP.
 *
 * Le serveur ne décode jamais l'image (pas de décodeur natif, pas de risque
 * de bombe de décompression côté serveur) : il vérifie que les octets
 * commencent par la signature du format déclaré par le contenu réel, et il
 * déduit l'extension de cette signature — jamais du MIME que le client
 * annonce. Un SVG ou un HTML déguisé en `image/jpeg` est donc refusé, et un
 * fichier valide reste servi sous le bon type (`media.controller.ts` lit
 * l'extension dans la table `media-kinds.ts`).
 *
 * Les dimensions en pixels ne sont pas lisibles dans ces en-têtes sans
 * parser le format en entier : elles ne sont pas contrôlées ici. Le risque
 * résiduel est un décodage coûteux côté client (image de très grandes
 * dimensions en petit fichier) ; le mobile recadre l'avatar au carré avant
 * l'envoi, et l'affichage se fait en vignette `expo-image`.
 */

export type ImageKind = 'jpeg' | 'png' | 'webp';

export interface DetectedImage {
  kind: ImageKind;
  /** Extension canonique écrite sur le disque et servie par `/media`. */
  extension: 'jpg' | 'png' | 'webp';
}

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46]; // « RIFF »
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50]; // « WEBP »

function startsWith(buffer: Buffer, signature: readonly number[], offset = 0): boolean {
  if (buffer.length < offset + signature.length) return false;
  return signature.every((byte, index) => buffer[offset + index] === byte);
}

/**
 * Détecte le format d'une image à partir de ses premiers octets.
 * Renvoie `null` pour tout autre contenu (SVG, HTML, GIF, texte, vide…).
 */
export function detectImageKind(buffer: Buffer): DetectedImage | null {
  if (startsWith(buffer, JPEG_SIGNATURE)) {
    return { kind: 'jpeg', extension: 'jpg' };
  }
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return { kind: 'png', extension: 'png' };
  }
  // WebP : conteneur RIFF dont le type à l'offset 8 vaut « WEBP ».
  if (startsWith(buffer, RIFF_SIGNATURE) && startsWith(buffer, WEBP_SIGNATURE, 8)) {
    return { kind: 'webp', extension: 'webp' };
  }
  return null;
}

/**
 * Décode un base64 strict : `Buffer.from(x, 'base64')` ignore silencieusement
 * les caractères invalides et produit un buffer partiel. On rejette donc
 * tout caractère hors alphabet (avec padding `=` final éventuel) avant de
 * décoder, et on vérifie la taille de la chaîne avant l'allocation.
 */
const STRICT_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export function isStrictBase64(value: string): boolean {
  return value.length % 4 === 0 && STRICT_BASE64_PATTERN.test(value);
}
