/**
 * Prepares a database before the suite runs.
 *
 * On SQLite, `prisma/test.db` is deleted outright and a plain `prisma db push` rebuilds it, so
 * every run starts from a known empty schema and no test can depend on another's leftovers.
 *
 * On MySQL (how CI proves the real row-locking path) the schema is pushed but the database is NOT
 * dropped - that is CI's own throwaway service container, and a script that deletes whatever
 * DATABASE_URL points at is one typo away from destroying something real. `resetDatabase()` in
 * `db.ts` clears the tables per test, which is enough for isolation either way.
 *
 * Deliberately no `--force-reset` or `--accept-data-loss`: those flags exist to destroy data in an
 * existing database, and they do not belong in a script that reads its target from the environment.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export default function setup(): void {
  const apiDir = resolve(import.meta.dirname, "../..");
  const prismaDir = resolve(apiDir, "prisma");

  const provider = process.env["DATABASE_PROVIDER"] ?? "sqlite";
  const isSqlite = provider === "sqlite";

  const databaseUrl = isSqlite ? "file:./test.db" : process.env["DATABASE_URL"];
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required when DATABASE_PROVIDER is not sqlite");

  if (isSqlite) {
    // SQLite relative URLs resolve against the schema's directory.
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const file = resolve(prismaDir, `test.db${suffix}`);
      if (existsSync(file)) rmSync(file, { force: true });
    }
  }

  const schema = isSqlite ? "prisma/schema.sqlite.prisma" : "prisma/schema.prisma";

  // Regenerate the derived SQLite schema so it cannot be stale against schema.prisma.
  if (isSqlite) {
    const generate = spawnSync("node", ["prisma/sqlite.mjs"], {
      cwd: apiDir,
      shell: true,
      stdio: "pipe",
    });
    if (generate.status !== 0) {
      throw new Error(
        `failed to derive the SQLite schema:\n${generate.stdout?.toString() ?? ""}${generate.stderr?.toString() ?? ""}`,
      );
    }
  }

  const result = spawnSync("npx", ["prisma", "db", "push", "--skip-generate", "--schema", schema], {
    cwd: apiDir,
    shell: true,
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_PROVIDER: provider },
  });

  if (result.status !== 0) {
    const output = `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`;
    throw new Error(`failed to prepare the ${provider} test database:\n${output}`);
  }
}
