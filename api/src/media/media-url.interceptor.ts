import { Injectable, type NestInterceptor, type ExecutionContext, type CallHandler } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { MediaService } from './media.service.js';

/**
 * Réécrit les chemins de médias à la sortie de l'API.
 *
 * Placé à la frontière plutôt que dans chaque objet transmis : un chemin
 * « /uploads/… » qui traînerait dans une réponse — avatar d'un membre, aperçu du
 * dernier message, profil, pièce jointe — ne serait plus lisible que par son
 * destinataire. Ici, tout ce qui sort est signé et expire.
 */
@Injectable()
export class MediaUrlInterceptor implements NestInterceptor {
  constructor(private readonly media: MediaService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => this.signValue(data)));
  }

  private signValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return value.startsWith('/uploads/') ? this.media.sign(value) : value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.signValue(entry));
    }
    // Dates, Buffers, flux, primitives : rien à parcourir à l'intérieur.
    if (!value || typeof value !== 'object' || value instanceof Date) {
      return value;
    }
    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      copy[key] = this.signValue(entry);
    }
    return copy;
  }
}
