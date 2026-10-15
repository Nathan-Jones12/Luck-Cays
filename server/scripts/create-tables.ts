/**
 * Creates the Luck-Cays tables from db/schema.sql.
 *
 * Safe by design: if any table the schema would create already exists, it stops without
 * changing anything. It never drops or alters an existing table.
 *
 * Note: MySQL DDL is not transactional. If a statement fails part-way, the tables created
 * before it remain - the output says exactly which statement failed.
 */
import { readFileSync } from "node:fs";
import { pool } from "../src/db.js";

const sql = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");

// Strip `--` comment lines, then split on the semicolons that end each statement. The
// schema has no semicolons inside strings, so this split is exact for this file.
const statements = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const wanted = statements
  .map((s) => /^CREATE TABLE `([^`]+)`/.exec(s)?.[1])
  .filter((t): t is string => Boolean(t));

try {
  const [rows] = await pool.query(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()",
  );
  const existing = new Set((rows as { name: string }[]).map((r) => r.name));
  const clashes = wanted.filter((t) => existing.has(t));

  if (clashes.length > 0) {
    console.error(`Stopped: these tables already exist, nothing was changed:\n  ${clashes.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log(`Creating ${wanted.length} tables (${statements.length} statements)...`);
    for (const [i, statement] of statements.entries()) {
      try {
        await pool.query(statement);
      } catch (err) {
        console.error(`Statement ${i + 1} failed:\n${statement.slice(0, 200)}\n`, err);
        process.exitCode = 1;
        break;
      }
    }
    if (!process.exitCode) console.log(`Done. Created: ${wanted.join(", ")}`);
  }
} finally {
  await pool.end();
}
