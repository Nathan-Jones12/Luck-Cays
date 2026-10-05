/**
 * Launch routes: the two calls that make an embed work.
 *
 *   POST /api/launch          a signed-in player asks for an iframe URL
 *   POST /api/launch/exchange the game redeems that URL's ticket, once
 *
 * The exchange route is deliberately unauthenticated. The ticket IS the credential, and the
 * game has nothing else at the moment it calls - that is the point of the design.
 */
import { Router } from "express";
import { createLaunchSchema, exchangeLaunchSchema } from "@luck-cays/shared";
import { authOf, requireAuth } from "../../middleware/auth.js";
import { gameplayLimiter, globalLimiter } from "../../middleware/rate-limit.js";
import { body, validateBody } from "../../middleware/validate.js";
import { createLaunch, exchangeLaunch } from "./launch.service.js";

export const launchRouter = Router();

launchRouter.post(
  "/",
  requireAuth,
  gameplayLimiter,
  validateBody(createLaunchSchema),
  async (request, response) => {
    const { userId } = authOf(request);
    const input = body(request, createLaunchSchema);

    // Default the embed origin to wherever the request came from, so the common case pins
    // itself without the caller having to think about it.
    const origin = input.origin ?? request.headers.origin;

    response.json(
      await createLaunch({
        userId,
        gameSlug: input.gameSlug,
        brand: input.brand,
        ...(origin ? { origin } : {}),
        ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
      }),
    );
  },
);

launchRouter.post(
  "/exchange",
  globalLimiter,
  validateBody(exchangeLaunchSchema),
  async (request, response) => {
    const { token } = body(request, exchangeLaunchSchema);
    response.json(await exchangeLaunch(token, request.headers.origin));
  },
);
