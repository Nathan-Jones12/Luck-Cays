/**
 * VIP routes. Read-only: points and tiers are moved by gameplay, never by a request.
 */
import { Router } from "express";
import { authOf, requireAuth } from "../../middleware/auth.js";
import { getProgress, listTiers } from "./vip.service.js";

export const vipRouter = Router();

/** Public, so the tier ladder can be advertised before signup. */
vipRouter.get("/tiers", async (_request, response) => {
  response.json({ tiers: await listTiers() });
});

vipRouter.get("/me", requireAuth, async (request, response) => {
  const { userId } = authOf(request);
  response.json(await getProgress(userId));
});
