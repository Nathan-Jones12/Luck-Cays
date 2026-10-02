/**
 * Derives a SQLite schema from the canonical MySQL one.
 *
 * The PRD's data layer is MySQL 8, and `schema.prisma` targets it. The prototype
 * runs on SQLite so it needs no Docker, and Prisma fixes the provider at the schema
 * level, so a second schema file is unavoidable. This generates it rather than
 * asking anyone to keep two files in step by hand.
 *
 * The transform is deliberately tiny, and anything beyond it should be a build
 * failure rather than a silent difference between the two databases:
 *
 *   1. swap the datasource provider to sqlite
 *   2. drop `@db.Text` - MySQL needs it (String would otherwise be VARCHAR(191),
 *      too small for a slot config); SQLite has no such limit and rejects the
 *      attribute
 *
 * Deliberately NOT handled, because the canonical schema avoids them: `enum` blocks
 * (unsupported on SQLite, which is why status columns are String) and every other
 * `@db.*` native type. If one appears, this script fails loudly.
 *
 * Plain .mjs, not TypeScript: it runs before any TS tooling in `db:push`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, "schema.prisma");
const TARGET = resolve(here, "schema.sqlite.prisma");

const source = readFileSync(SOURCE, "utf8");

if (/^\s*enum\s+\w+\s*\{/m.test(source)) {
  console.error(
    "schema.prisma declares an enum. Prisma does not support enums on SQLite, so the\n" +
      "canonical schema must use String columns constrained by zod instead. Remove the\n" +
      "enum or teach this script how to translate it.",
  );
  process.exit(1);
}

// Everything except @db.Text, which is the one attribute we know how to drop.
const unsupported = [...source.matchAll(/@db\.(?!Text\b)(\w+)/g)].map((m) => m[0]);
if (unsupported.length > 0) {
  console.error(
    `schema.prisma uses MySQL-only native types this script cannot translate: ${[
      ...new Set(unsupported),
    ].join(", ")}\n` + "Either avoid them in the canonical schema or extend prisma/sqlite.mjs.",
  );
  process.exit(1);
}

let output = source.replace(/(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"mysql"/s, '$1"sqlite"');

if (!/provider\s*=\s*"sqlite"/.test(output)) {
  console.error("could not rewrite the datasource provider - has the datasource block changed?");
  process.exit(1);
}

// Strip `@db.Text`, including the space before it, leaving no trailing whitespace.
output = output.replace(/ *@db\.Text/g, "");

const banner = [
  "// GENERATED FILE - DO NOT EDIT.",
  "//",
  "// Derived from schema.prisma by prisma/sqlite.mjs. Edit the MySQL schema and run",
  "// `npm run db:schema --workspace @luck-cays/api` to regenerate this one.",
  "//",
  "// SQLite has no SELECT ... FOR UPDATE, so the wallet serialises debits through an",
  "// in-process mutex when running on this provider. That is safe for one API process",
  "// and only one: see the LOCKING notes in src/modules/wallet/wallet.service.ts.",
  "",
].join("\n");

writeFileSync(TARGET, banner + output);
console.log("prisma/schema.sqlite.prisma written from schema.prisma");
