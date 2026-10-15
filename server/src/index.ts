import express from "express";
import { pool } from "./db.js";

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

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
