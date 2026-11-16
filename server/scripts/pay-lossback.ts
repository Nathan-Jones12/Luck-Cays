/**
 * Runs the daily lossback payout once, now. The server already does this on its own every
 * minute; this is for running it by hand. Safe to repeat: nobody is ever paid twice.
 * Usage: npm run job:lossback
 */
import { pool } from "../src/db.js";
import { payDailyLossback } from "../src/jobs/lossback.js";

try {
  console.log(JSON.stringify(await payDailyLossback(), null, 2));
} finally {
  await pool.end();
}
