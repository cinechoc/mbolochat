import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * URLs de médias signées et à durée limitée.
 *
 * Les fichiers sont posés sur le disque du serveur et ne sont plus servis
 * publiquement : sans signature, une réponse 404. Le nom d'un fichier ne suffit
 * plus — une URL recopiée dans un capture d'écran, un historique de notifications
 * ou un journal devient inopérante au bout d'un moment.
 *
 * L'expiration est calée sur une fenêtre, pas sur l'instant de l'appel : deux
 * clients qui demandent la même image dans la même fenêtre reçoivent la même URL,
 * donc le cache image de l'appareil reste valide.
 */

/** Fenêtre de validité d'une URL signée. */
const WINDOW_SECONDS = 6 * 60 * 60;

/** Préfixe de lecture des médias. */
export const MEDIA_ROUTE = '/media';

/** Ce qu'il faut signer dans un message qui sort de l'API. */
export interface MediaBearing {
  attachment: { url: string } | null;
  sender: { avatarUrl: string | null };
}

@Injectable()
export class MediaService {
  private readonly secret: string;

  constructor(config: ConfigService) {
    const secret = config.get<string>('MEDIA_SECRET') || config.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('MEDIA_SECRET (ou JWT_SECRET) est requis pour signer les URLs de médias');
    }
    this.secret = secret;
  }

  /**
   * Chemin d'accès signé pour un fichier stocké. Une valeur déjà signée, ou une
   * adresse distante, ressort inchangée : re-signer abîmerait l'URL.
   *
   * Les avatars sont stockés avec un anti-cache (`/uploads/x.jpg?v=…`) : il est
   * remis à plat comme paramètre à part entière. Inclus dans le chemin signé, il
   * ne ressemblerait plus à rien côté vérification, et le fichier serait cherché
   * sous un nom qui n'existe pas.
   */
  sign(storedPath: string): string {
    if (!storedPath.startsWith('/uploads/')) {
      return storedPath;
    }
    const separator = storedPath.indexOf('?');
    const path = separator === -1 ? storedPath : storedPath.slice(0, separator);
    const cacheBuster = separator === -1 ? '' : `&${storedPath.slice(separator + 1)}`;
    const expiresAt = this.windowEnd();
    return `${MEDIA_ROUTE}?f=${encodeURIComponent(path)}&e=${expiresAt}&s=${this.signature(path, expiresAt)}${cacheBuster}`;
  }

  /** Variante tolérante pour les champs qui peuvent être absents. */
  signOrNull(storedPath: string | null | undefined): string | null {
    return storedPath ? this.sign(storedPath) : null;
  }

  /** Vérifie la signature et la fenêtre, et renvoie le chemin du fichier demandé. */
  verify(file: string | undefined, expiresAt: number | undefined, signature: string | undefined): string {
    if (!file || !expiresAt || !signature) {
      throw new UnauthorizedException('Média non autorisé');
    }
    // La fenêtre est figée : on recompare la valeur exacte qui a été signée.
    if (expiresAt * 1000 <= Date.now()) {
      throw new UnauthorizedException('Lien expiré');
    }
    const expected = this.signature(file, expiresAt);
    const given = Buffer.from(signature, 'utf8');
    const reference = Buffer.from(expected, 'utf8');
    if (given.length !== reference.length || !timingSafeEqual(given, reference)) {
      throw new UnauthorizedException('Média non autorisé');
    }
    return file;
  }

  /**
   * Signature des chemins d'un message qui quitte l'API hors HTTP — diffusion
   * temps réel, notification push. L'intercepteur ne couvre que les réponses.
   */
  signMessage<T extends MediaBearing>(message: T): T {
    return {
      ...message,
      attachment: message.attachment ? { ...message.attachment, url: this.sign(message.attachment.url) } : null,
      sender: { ...message.sender, avatarUrl: this.signOrNull(message.sender.avatarUrl) },
    };
  }

  /** Fin de la fenêtre courante, en secondes depuis l'époque. */
  private windowEnd(): number {
    return (Math.floor(Date.now() / 1000 / WINDOW_SECONDS) + 1) * WINDOW_SECONDS;
  }

  private signature(file: string, expiresAt: number): string {
    return createHmac('sha256', this.secret).update(`${file}:${expiresAt}`).digest('hex');
  }
}
