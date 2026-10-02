/**
 * Sportsbook routes. Browsing is public; the bet slip needs an account.
 */
import { Router } from "express";
import {
  betsQuerySchema,
  chipsFromJson,
  eventsQuerySchema,
  placeBetSchema,
} from "@luck-cays/shared";
import { authOf, requireAuth } from "../../middleware/auth.js";
import { betLimiter } from "../../middleware/rate-limit.js";
import { body, query, validateBody, validateQuery } from "../../middleware/validate.js";
import { listBets, listEvents, listSports, placeBet } from "./sports.service.js";

export const sportsRouter = Router();

sportsRouter.get("/sports", async (_request, response) => {
  response.json({ sports: await listSports() });
});

sportsRouter.get("/events", validateQuery(eventsQuerySchema), async (request, response) => {
  const options = query(request, eventsQuerySchema);
  response.json(
    await listEvents({
      limit: options.limit,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.sport ? { sport: options.sport } : {}),
      ...(options.league ? { league: options.league } : {}),
    }),
  );
});

sportsRouter.post(
  "/bets",
  requireAuth,
  betLimiter,
  validateBody(placeBetSchema),
  async (request, response) => {
    const { userId } = authOf(request);
    const input = body(request, placeBetSchema);

    const bet = await placeBet({
      userId,
      marketId: input.marketId,
      selection: input.selection,
      odds: input.odds,
      stake: chipsFromJson(input.stake),
      idempotencyKey: input.idempotencyKey,
      acceptOddsChange: input.acceptOddsChange,
    });

    response.status(201).json(bet);
  },
);

sportsRouter.get(
  "/bets",
  requireAuth,
  validateQuery(betsQuerySchema),
  async (request, response) => {
    const { userId } = authOf(request);
    const options = query(request, betsQuerySchema);

    response.json(
      await listBets(userId, {
        limit: options.limit,
        ...(options.cursor ? { cursor: options.cursor } : {}),
        ...(options.status ? { status: options.status } : {}),
      }),
    );
  },
);
