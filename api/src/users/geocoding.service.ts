import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, ilike } from 'drizzle-orm';

import { DRIZZLE, type Database } from '../db/db.module.js';
import { geoCityCache } from '../db/schema.js';
import { roundedCoordinates, type Coordinate } from './location-policy.js';

export type GeocodedCity = Coordinate & {
  city: string;
  country: string | null;
};

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOMINATIM_MIN_INTERVAL_MS = 1000;

/**
 * Géocodage inverse côté serveur (Nominatim/OSM par défaut). Les coordonnées
 * d'un utilisateur ne sont jamais stockées : seul le cache par cellule arrondie
 * garde un nom de ville et un pays. Aucune clé de service dans l'application.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private chain: Promise<void> = Promise.resolve();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  private get baseUrl(): string {
    return this.config.get<string>('GEOCODE_BASE_URL') ?? 'https://nominatim.openstreetmap.org/reverse';
  }

  private get userAgent(): string {
    return this.config.get<string>('GEOCODE_USER_AGENT') ?? 'MboloChat/1.0';
  }

  /** Cellule d'environ 1 km : suffisante pour une ville, inutile pour tracer. */
  private static cellOf(latitude: number, longitude: number): string {
    return `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
  }

  async reverse(latitude: number, longitude: number): Promise<GeocodedCity | null> {
    // Nominatim n'a besoin que de la ville : ~1 km suffit, jamais la position fine.
    const point = roundedCoordinates({ latitude, longitude });
    const cell = GeocodingService.cellOf(point.latitude, point.longitude);
    const [cached] = await this.db
      .select()
      .from(geoCityCache)
      .where(eq(geoCityCache.cell, cell))
      .limit(1);
    if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
      return {
        city: cached.city,
        country: cached.country,
        latitude: cached.latitude,
        longitude: cached.longitude,
      };
    }

    const result = await this.request(point.latitude, point.longitude);
    if (!result) {
      return cached
        ? {
            city: cached.city,
            country: cached.country,
            latitude: cached.latitude,
            longitude: cached.longitude,
          }
        : null;
    }

    await this.db
      .insert(geoCityCache)
      .values({
        cell,
        city: result.city,
        country: result.country,
        latitude: point.latitude,
        longitude: point.longitude,
        fetchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: geoCityCache.cell,
        set: {
          city: result.city,
          country: result.country,
          latitude: point.latitude,
          longitude: point.longitude,
          fetchedAt: new Date(),
        },
      });
    return result;
  }

  /** Coordonnées approximatives d'une ville connue, pour l'anti-téléport. */
  async coordsForCity(city: string, country: string | null): Promise<Coordinate | null> {
    const rows = await this.db
      .select({
        latitude: geoCityCache.latitude,
        longitude: geoCityCache.longitude,
      })
      .from(geoCityCache)
      .where(
        country
          ? and(ilike(geoCityCache.city, city), ilike(geoCityCache.country, country))
          : ilike(geoCityCache.city, city),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async request(latitude: number, longitude: number): Promise<GeocodedCity | null> {
    try {
      const url = new URL(this.baseUrl);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('lat', String(latitude));
      url.searchParams.set('lon', String(longitude));
      url.searchParams.set('zoom', '10');
      url.searchParams.set('accept-language', 'fr');
      const response = await this.limited(() =>
        fetch(url, {
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        }),
      );
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as {
        address?: Record<string, string>;
      };
      const address = body.address ?? {};
      const city =
        address.city ??
        address.town ??
        address.village ??
        address.municipality ??
        address.county ??
        null;
      if (!city) {
        return null;
      }
      return {
        city,
        country: address.country ?? null,
        latitude,
        longitude,
      };
    } catch (error) {
      // Jamais de coordonnées dans les journaux : seulement la nature de l'échec.
      this.logger.warn(
        `Géocodage indisponible (${error instanceof Error ? error.name : 'inconnu'})`,
      );
      return null;
    }
  }

  /** Une requête à la fois, espacées d'au moins une seconde (politique OSM). */
  private async limited<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.chain;
    let release: () => void = () => {};
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      setTimeout(release, NOMINATIM_MIN_INTERVAL_MS);
    }
  }
}
