/**
 * Runs every statement in a .sql file against the database, in order, stopping at the
 * first failure. Usage: npm run db:sql -- db/seed.sql
 *
 * MySQL DDL is not transactional: if a statement fails, the ones before it have already
 * been applied. The output says which statement failed.
 */
import { resolve } from "node:path";
import { pool } from "../src/db.js";
import { readStatements } from "./sql.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run db:sql -- <path/to/file.sql>");
  process.exit(1);
}

const statements = readStatements(resolve(file));
console.log(`Running ${statements.length} statements from ${file}...`);

try {
  for (const [i, statement] of statements.entries()) {
    try {
      await pool.query(statement);
    } catch (err) {
      console.error(`Statement ${i + 1} failed:\n${statement.slice(0, 300)}\n`, err);
      process.exitCode = 1;
      break;
    }
  }
  if (!process.exitCode) console.log("Done.");
} finally {
  await pool.end();
}
