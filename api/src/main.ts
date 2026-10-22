import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { DRIZZLE, type Database } from './db/db.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
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
  const allowedOrigins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  });

  const logger = new Logger('HTTP');
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      logger.log(`${req.method} ${req.originalUrl} -> ${res.statusCode}`);
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
