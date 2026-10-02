/**
 * Slot routes.
 *
 * The lobby and paytable are public so a visitor can look around before signing up;
 * spinning and history need an account.
 */
import { Router } from "express";
import { chipsFromJson, spinHistoryQuerySchema, spinSchema } from "@luck-cays/shared";
import { authOf, requireAuth } from "../../middleware/auth.js";
import { gameplayLimiter } from "../../middleware/rate-limit.js";
import { body, query, validateBody, validateQuery } from "../../middleware/validate.js";
import {
  getFreeSpinState,
  getGameConfig,
  getSpinHistory,
  listGames,
  spin,
} from "./slots.service.js";

export const slotsRouter = Router();

slotsRouter.get("/", async (_request, response) => {
  response.json({ games: await listGames() });
});

/**
 * The full config, including reel strips and the paytable.
 *
 * Publishing the strips is safe and deliberate: the player can verify the paytable they
 * are being offered, and knowing a strip's contents tells you nothing about the next
 * stop, which is drawn from crypto.randomInt on the server.
 */
slotsRouter.get("/:slug", async (request, response) => {
  const slug = String(request.params["slug"]);
  response.json({ config: await getGameConfig(slug) });
});

slotsRouter.get("/:slug/free-spins", requireAuth, async (request, response) => {
  const { userId } = authOf(request);
  const slug = String(request.params["slug"]);
  response.json({ freeSpins: await getFreeSpinState(userId, slug) });
});

slotsRouter.post(
  "/spin",
  requireAuth,
  gameplayLimiter,
  validateBody(spinSchema),
  async (request, response) => {
    const { userId } = authOf(request);
    const input = body(request, spinSchema);

    response.json(
      await spin({
        userId,
        gameSlug: input.gameSlug,
        bet: chipsFromJson(input.bet),
        idempotencyKey: input.idempotencyKey,
      }),
    );
  },
);

slotsRouter.get(
  "/history/rounds",
  requireAuth,
  validateQuery(spinHistoryQuerySchema),
  async (request, response) => {
    const { userId } = authOf(request);
    const options = query(request, spinHistoryQuerySchema);

    response.json(
      await getSpinHistory(userId, {
        limit: options.limit,
        ...(options.cursor ? { cursor: options.cursor } : {}),
        ...(options.gameSlug ? { gameSlug: options.gameSlug } : {}),
      }),
    );
  },
);
