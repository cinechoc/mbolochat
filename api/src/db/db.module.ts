import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export const DRIZZLE = 'DRIZZLE';

export type Database = NodePgDatabase<typeof schema>;

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pool = new Pool({
          connectionString: config.get<string>('DATABASE_URL'),
        });
        const database = drizzle(pool, { schema });
        return database;
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DbModule {}
