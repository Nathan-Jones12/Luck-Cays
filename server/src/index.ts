import express from "express";
import { pool } from "./db.js";
import { startLossbackSchedule } from "./jobs/lossback.js";
import { getTiers } from "./vip.js";

const app = express();
app.use(express.json());

/** Confirms the server is up and can reach the database. */
app.get("/api/health", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT VERSION() AS version");
    const version = (rows as { version: string }[])[0]?.version;
    res.json({ ok: true, database: "connected", mysqlVersion: version });
  } catch (err) {
    // Log the detail server-side; never send a SQL error or stack trace to the browser.
    console.error("[health] database check failed:", err);
    res.status(503).json({ ok: false, database: "unreachable" });
  }
});

/** The VIP ladder. Public: it is shown before sign-up. */
app.get("/api/vip/tiers", async (_req, res) => {
  try {
    res.json({ tiers: await getTiers() });
  } catch (err) {
    console.error("[vip] tiers failed:", err);
    res.status(500).json({ error: "Could not load VIP tiers" });
  }
});

// GET /api/vip/me (a player's progress, from getProgress in vip.ts) needs to know who is
// asking, so it is added together with authentication.

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});

startLossbackSchedule();
