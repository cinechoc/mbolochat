import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { DRIZZLE, type Database } from './db/db.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({ origin: true, credentials: true });

  const logger = new Logger('HTTP');
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      logger.log(`${req.method} ${req.originalUrl} -> ${res.statusCode}`);
    });
    next();
  });

  const uploadsDir = join(process.cwd(), 'uploads');
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  app.useStaticAssets(uploadsDir, { prefix: '/uploads' });

  const webDist = join(process.cwd(), '..', 'mobile', 'dist');
  if (existsSync(webDist)) {
    app.useStaticAssets(webDist);
    const indexHtml = join(webDist, 'index.html');
    const apiPrefixes = ['/auth', '/users', '/conversations', '/socket.io'];
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

  const port = app.get(ConfigService).get<number>('PORT') ?? 3000;
  await app.listen(port);
}
await bootstrap();
