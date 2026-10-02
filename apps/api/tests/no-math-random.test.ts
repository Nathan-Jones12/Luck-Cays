/**
 * `Math.random` is banned in the API.
 *
 * It is seeded predictably by V8, so a reel stop or a shuffle drawn from it is guessable, and a
 * guessable shuffle is a solved game. Everything that decides an outcome, shuffles a deck or
 * mints a token must come from `node:crypto`.
 *
 * This is a lint rule enforced as a test, because lint is easy to skip and a test is not.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../src");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (extname(entry) === ".ts") {
      found.push(full);
    }
  }
  return found;
}

describe("randomness", () => {
  it("never calls Math.random anywhere in apps/api/src", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const contents = readFileSync(file, "utf8");

      for (const [index, line] of contents.split("\n").entries()) {
        // Skip comments: the ban is discussed in prose in several files.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"))
          continue;

        if (/\bMath\s*\.\s*random\b/.test(line)) {
          offenders.push(`${relative(SRC, file)}:${index + 1}  ${trimmed}`);
        }
      }
    }

    expect(
      offenders,
      `Math.random is banned in apps/api. Use secureRandomInt / secureShuffle / secureToken from lib/crypto.ts:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("routes every outcome through lib/crypto rather than importing node:crypto ad hoc", () => {
    // Files legitimately allowed to import node:crypto directly.
    const allowed = new Set(["lib/crypto.ts", "lib/env.ts"]);
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const key = relative(SRC, file).replace(/\\/g, "/");
      if (allowed.has(key)) continue;

      const contents = readFileSync(file, "utf8");
      // `randomUUID` off the global is fine - it is a identifier, not an outcome.
      if (/from "node:crypto"/.test(contents)) {
        offenders.push(key);
      }
    }

    expect(
      offenders,
      `These files import node:crypto directly. Outcome randomness belongs in lib/crypto.ts so it can be audited in one place:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
