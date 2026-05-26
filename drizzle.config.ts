import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./backend/db/schema.ts",
  out: "./backend/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: "./data/dev.db",
  },
});
