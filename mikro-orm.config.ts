import { defineConfig } from '@mikro-orm/postgresql';

export default defineConfig({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  dbName: process.env.DB_NAME || 'financial_db',
  entities: ['./dist/infrastructure/persistence/entities'],
  entitiesTs: ['./src/infrastructure/persistence/entities'],
  migrations: {
    path: './src/infrastructure/persistence/migrations',
    pathTs: './src/infrastructure/persistence/migrations',
    glob: '!(*.d).{js,ts}',
    snapshot: false,
  },
});
