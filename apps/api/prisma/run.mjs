/**
 * Runs the Prisma CLI against whichever schema the configured provider needs.
 *
 *   node prisma/run.mjs db push --accept-data-loss
 *   node prisma/run.mjs generate
 *   node prisma/run.mjs studio
 *
 * This exists instead of `--schema $(node prisma/which-schema.mjs)` in package.json
 * because npm runs scripts through cmd.exe on Windows, where `$(...)` is not command
 * substitution - it is passed through as a literal path and Prisma fails on it.
 *
 * Regenerates the SQLite schema first, so it can never be stale relative to the
 * canonical MySQL one.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Prisma looks for .env beside the schema or in the cwd; ours lives at the repo
// root, so load it explicitly before the CLI needs DATABASE_URL.
const rootEnv = resolve(here, "../../../.env");
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
} else {
  console.error(
    `no .env at ${rootEnv}\nCopy .env.example to .env at the repo root and set DATABASE_URL.`,
  );
  process.exit(1);
}

function resolveProvider() {
  if (process.env.DATABASE_PROVIDER) return process.env.DATABASE_PROVIDER.trim();

  const envPath = resolve(here, "../../../.env");
  if (existsSync(envPath)) {
    const match = readFileSync(envPath, "utf8").match(/^\s*DATABASE_PROVIDER\s*=\s*(.+)$/m);
    if (match?.[1]) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  return "sqlite";
}

const provider = resolveProvider();
if (provider !== "sqlite" && provider !== "mysql") {
  console.error(`DATABASE_PROVIDER must be "sqlite" or "mysql", got "${provider}"`);
  process.exit(1);
}

// Always refresh the derived schema so it cannot drift from schema.prisma. Imported
// rather than spawned: node's own path contains a space on Windows, which a shelled
// spawn would split.
await import("./sqlite.mjs");

const schema = provider === "mysql" ? "prisma/schema.prisma" : "prisma/schema.sqlite.prisma";
const args = process.argv.slice(2);

console.log(`prisma ${args.join(" ")}  (provider: ${provider}, schema: ${schema})`);

const result = spawnSync("npx", ["prisma", ...args, "--schema", schema], {
  stdio: "inherit",
  shell: true,
  cwd: resolve(here, ".."),
});
process.exit(result.status ?? 1);
