import { readFileSync } from "node:fs";

/**
 * Splits a .sql file into statements: drops `--` comment lines, then splits on `;`.
 * Deliberately simple - it does not understand quoting, so keep semicolons out of
 * string literals in the db/ files.
 */
export function readStatements(path: string | URL): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}
