/**
 * Poker over REST is only for discovery - the lobby listing and a table snapshot. All
 * gameplay runs over Socket.IO (see `sockets/poker.socket.ts`), because a hand needs the
 * server to push state when someone else acts.
 */
import { Router } from "express";
import { optionalAuth, requireAuth } from "../../middleware/auth.js";
import { listTables, viewTable } from "./poker.service.js";

export const pokerRouter = Router();

pokerRouter.get("/tables", async (_request, response) => {
  response.json({ tables: await listTables() });
});

/**
 * A snapshot, so a page load can render before the socket connects. Hole cards come from
 * the per-viewer projection, so an anonymous viewer sees none and a seated player sees only
 * their own.
 */
pokerRouter.get("/tables/:id", optionalAuth, async (request, response) => {
  const tableId = String(request.params["id"]);
  response.json({ table: await viewTable(tableId, request.auth?.userId ?? null) });
});

/** Which tables the signed-in player is sitting at, so the UI can offer "return to table". */
pokerRouter.get("/my-seats", requireAuth, async (request, response) => {
  const { tablesFor } = await import("./poker.service.js");
  response.json({ tableIds: tablesFor(request.auth?.userId ?? "") });
});
