import { defineConfig } from 'prisma/config';
import * as dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  schema: 'schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});