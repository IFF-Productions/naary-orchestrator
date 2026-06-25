import { defineConfig, env } from "prisma/config";

// Prisma 7 config: the CLI (migrate/studio) reads the datasource connection from
// here, not from schema.prisma. DATABASE_URL is loaded from the repo-root .env by
// dotenv-cli (see this package's scripts).
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
