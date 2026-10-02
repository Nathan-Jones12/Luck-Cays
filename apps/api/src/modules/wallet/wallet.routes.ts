/**
 * Wallet routes: balance, ledger, bonuses.
 *
 * Chip amounts leave as decimal strings, never JSON numbers - a balance can exceed
 * 2^53 and a number would quietly round it.
 */
import { Router } from "express";
import { claimBonusSchema, ledgerQuerySchema } from "@luck-cays/shared";
import { authOf, requireAuth } from "../../middleware/auth.js";
import { betLimiter } from "../../middleware/rate-limit.js";
import { body, query, validateBody, validateQuery } from "../../middleware/validate.js";
import { badRequest } from "../../lib/errors.js";
import { claimDailyBonus, getBonusStatus, grantSignupBonus } from "./bonus.service.js";
import { getBalance, getLedger } from "./wallet.service.js";

export const walletRouter = Router();

walletRouter.use(requireAuth);

walletRouter.get("/", async (request, response) => {
  const { userId } = authOf(request);
  response.json({ balance: (await getBalance(userId)).toString(10), currency: "LC" });
});

walletRouter.get("/ledger", validateQuery(ledgerQuerySchema), async (request, response) => {
  const { userId } = authOf(request);
  const options = query(request, ledgerQuerySchema);

  const page = await getLedger(userId, {
    limit: options.limit,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.type ? { type: options.type } : {}),
  });

  response.json({
    entries: page.entries.map((entry) => ({
      id: entry.id,
      amount: entry.amount.toString(10),
      type: entry.type,
      refType: entry.refType,
      refId: entry.refId,
      balanceAfter: entry.balanceAfter.toString(10),
      createdAt: entry.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
  });
});

walletRouter.get("/bonuses", async (request, response) => {
  const { userId } = authOf(request);
  response.json(await getBonusStatus(userId));
});

walletRouter.post(
  "/bonuses/claim",
  betLimiter,
  validateBody(claimBonusSchema),
  async (request, response) => {
    const { userId } = authOf(request);
    const { bonusType } = body(request, claimBonusSchema);

    // Only these two are player-claimable. Level-up and cashback are granted by the VIP
    // service and must not be requestable, or a player could mint their own rewards.
    if (bonusType === "daily") {
      const result = await claimDailyBonus(userId);
      response.json({
        bonusType: result.bonusType,
        amount: result.amount.toString(10),
        balance: result.balance.toString(10),
      });
      return;
    }

    if (bonusType === "signup") {
      const result = await grantSignupBonus(userId);
      response.json({
        bonusType: result.bonusType,
        amount: result.replayed ? "0" : result.amount.toString(10),
        balance: result.balance.toString(10),
        alreadyClaimed: result.replayed,
      });
      return;
    }

    throw badRequest("BONUS_NOT_CLAIMABLE", "That bonus is granted automatically, not claimed");
  },
);
