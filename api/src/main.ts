import { setDefaultResultOrder } from 'node:dns';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { allowedOriginsFromEnv, isAllowedOrigin } from './common/cors.js';
import { DRIZZLE, type Database } from './db/db.module.js';

/**
 * Certains réseaux (conteneurs, box, hébergeurs) annoncent une route IPv6 mais
 * ne l'acheminent pas. `fetch` choisit alors l'adresse IPv6 en premier et
 * expire avant de retomber sur IPv4, ce qui faisait échouer le géocodage
 * inverse alors que `curl` fonctionnait. On privilégie IPv4 tout en gardant
 * IPv6 en repli quand aucune adresse IPv4 n'existe.
 */
setDefaultResultOrder('ipv4first');

async function bootstrap() {
  // Le parseur JSON par défaut (100 Ko) rendait le plafond de 2 Mo des
  // avatars inatteignable : leur base64 (~2,8 Mo) était rejeté en 413 avant
  // tout contrôle applicatif. Plafond explicite de 3 Mo pour les corps JSON
  // et formulaires ; les routes restent bornées par le throttling et par
  // leurs propres validations, et les médias volumineux passent toujours
  // par le multipart (`/uploads`, 50 Mo).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.use(json({ limit: '3mb' }));
  app.use(urlencoded({ extended: true, limit: '3mb' }));
  // Sans ceci, SIGTERM ne déclencherait pas onApplicationShutdown : la
  // dernière présence ne serait pas écrite en base avant l'arrêt.
  app.enableShutdownHooks();
  const config = app.get(ConfigService);

  // En-têtes de sécurité. La CSP reste fermée : le client web servi par la même
  // API charge son bundle et ses images depuis cette origine.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  /**
   * Plus d'`origin: true` avec les jetons : une page web quelconque ne doit pas
   * pouvoir appeler l'API avec les identifiants d'un visiteur. Les applications
   * mobiles n'envoient pas d'en-tête Origin et passent donc toujours ; le web a
   * besoin que son origine soit déclarée dans CORS_ORIGINS.
   */
  const allowedOrigins = allowedOriginsFromEnv(config.get<string>('CORS_ORIGINS'));
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      callback(null, isAllowedOrigin(origin, allowedOrigins));
    },
    credentials: true,
  });

  const logger = new Logger('HTTP');
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      const e2eeEnabled = ['1', 'true'].includes((process.env.E2EE_ENABLED ?? '').toLowerCase());
      const path = e2eeEnabled ? req.originalUrl.split('?')[0] : req.originalUrl;
      logger.log(`${req.method} ${path} -> ${res.statusCode}`);
    });
    next();
  });

  // Les médias ne sont plus servis en statique : passer par Express avant Nest,
  // c'était les rendre lisibles par quiconque connaît (ou devine) le chemin. Ils
  // sortent désormais par la route /media, sous signature et avec expiration.
  const uploadsDir = join(process.cwd(), 'uploads');
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  const webDist = join(process.cwd(), '..', 'mobile', 'dist');
  if (existsSync(webDist)) {
    app.useStaticAssets(webDist);
    const indexHtml = join(webDist, 'index.html');
    const apiPrefixes = ['/auth', '/users', '/conversations', '/uploads', '/media', '/socket.io'];
    app.use((req: Request, res: Response, next: NextFunction) => {
      const isHtmlNavigation =
        req.method === 'GET' &&
        !apiPrefixes.some((prefix) => req.path.startsWith(prefix)) &&
        req.headers.accept?.includes('text/html');
      if (!isHtmlNavigation) {
        next();
        return;
      }
      res.sendFile(indexHtml);
    });
  }

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const database = app.get<Database>(DRIZZLE);
  await migrate(database, { migrationsFolder: 'drizzle' });

  const port = config.get<number>('PORT') ?? 3001;
  await app.listen(port);
}
await bootstrap();
