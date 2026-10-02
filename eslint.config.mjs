/**
 * ESLint, flat config.
 *
 * Beyond the usual recommended sets, three rules exist to enforce things this project cares
 * about more than most:
 *
 *  - `Math.random` is banned in the API. It is seeded predictably, so a reel stop or shuffle
 *    drawn from it is guessable. `apps/api/tests/no-math-random.test.ts` enforces the same rule
 *    as a test, because lint is easy to skip.
 *  - Only the wallet module may touch `wallets.balance` or `ledger_entries`.
 *  - Floating promises are errors, not warnings: an unawaited chip movement is a lost bet.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.prisma/**",
      "apps/api/prisma/schema.sqlite.prisma",
      "apps/web/dist/**",
      "packages/shared/src/slots/configs/**", // generated
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-console": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-implicit-coercion": "warn",
      "prefer-const": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // An `any` needs a comment explaining itself; this makes forgetting one visible.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  /* ----------------------------- the API's own rules ----------------------------- */

  {
    files: ["apps/api/src/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message:
            "Math.random is predictable. Use secureRandomInt, secureShuffle or secureToken from lib/crypto.ts - every outcome, shuffle and token must come from node:crypto.",
        },
      ],
    },
  },

  /**
   * Only the wallet writes balances. Enforced by banning the Prisma calls that could, outside
   * the one module allowed to make them.
   */
  {
    files: ["apps/api/src/**/*.ts"],
    ignores: ["apps/api/src/modules/wallet/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.property.name='wallet'][property.name=/^(update|updateMany|upsert)$/]",
          message:
            "Only modules/wallet may change a balance. Call wallet.debit(), wallet.credit() or wallet.transact() instead.",
        },
        {
          selector:
            "MemberExpression[object.property.name='ledgerEntry'][property.name=/^(create|createMany|update|updateMany|delete|deleteMany|upsert)$/]",
          message:
            "The ledger is written only by modules/wallet, and is append-only. Record movements through the wallet service.",
        },
      ],
    },
  },

  /* -------------------------------- type-aware ---------------------------------- */

  {
    files: ["apps/api/src/**/*.ts", "packages/shared/src/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // An unawaited promise in the money path is a bet that silently did not happen.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },

  /* ----------------------------------- Vue -------------------------------------- */

  ...pluginVue.configs["flat/recommended"],

  {
    files: ["apps/web/**/*.vue", "apps/web/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { parser: tseslint.parser },
    },
    rules: {
      // Single-file component names are the filename; a redundant `name` only drifts from it.
      "vue/multi-word-component-names": "off",
      "vue/max-attributes-per-line": "off",
      "vue/singleline-html-element-content-newline": "off",
      "vue/html-self-closing": "off",
      "vue/html-indent": "off",
      "vue/html-closing-bracket-newline": "off",
      "vue/attributes-order": "warn",
    },
  },

  /* ---------------------------------- tests ------------------------------------- */

  {
    files: ["**/*.test.ts", "**/tests/**/*.ts"],
    rules: {
      // Tests reach into shapes deliberately.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  /* --------------------------------- tooling ------------------------------------ */

  {
    files: ["**/*.mjs", "**/*.config.ts", "tools/**/*.ts", "apps/api/prisma/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
);
