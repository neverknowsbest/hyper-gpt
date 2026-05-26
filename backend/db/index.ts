import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { and, eq } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { users, providerConfigs, type User } from "./schema";
import type { ProviderId } from "../../shared/types";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
mkdirSync(DATA_DIR, { recursive: true });

const sqlite = new Database(join(DATA_DIR, "dev.db"));
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

export const db = drizzle(sqlite, {
  schema: { users, providerConfigs },
});

migrate(db, { migrationsFolder: "./backend/db/migrations" });

export function ensureLocalUser(): User {
  const existing = db.select().from(users).limit(1).get();
  if (existing) return existing;

  const id = crypto.randomUUID();
  db.insert(users)
    .values({ id, createdAt: new Date().toISOString(), metadata: {} })
    .run();
  return db.select().from(users).where(eq(users.id, id)).get()!;
}

// Bootstrap provider API keys from env vars on first launch.
// After this, the ProviderConfig table is the source of truth.
export function bootstrapProviderKeysFromEnv(userId: string): void {
  const envMap: Array<[ProviderId, string | undefined]> = [
    ["anthropic", process.env.ANTHROPIC_API_KEY],
    ["openai", process.env.OPENAI_API_KEY],
  ];

  for (const [provider, key] of envMap) {
    if (!key) continue;
    const existing = db
      .select()
      .from(providerConfigs)
      .where(
        and(
          eq(providerConfigs.userId, userId),
          eq(providerConfigs.provider, provider),
        ),
      )
      .get();
    if (existing) continue;
    const t = new Date().toISOString();
    db.insert(providerConfigs)
      .values({
        id: crypto.randomUUID(),
        userId,
        provider,
        apiKey: key,
        createdAt: t,
        updatedAt: t,
      })
      .run();
    console.log(`[bootstrap] saved ${provider} key from env`);
  }
}
