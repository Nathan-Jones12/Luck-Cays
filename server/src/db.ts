import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";

/**
 * The MySQL connection pool. Credentials come only from the environment (server/.env),
 * never from the frontend - anything shipped to the browser is readable by every visitor.
 *
 * DATABASE_URL is the URL Aiven gives you, e.g.
 *   mysql://avnadmin:PASSWORD@host.aivencloud.com:25893/defaultdb?ssl-mode=REQUIRED
 * mysql2 does not understand `ssl-mode`, so the URL is parsed here rather than passed as-is.
 */
function poolOptions(): mysql.PoolOptions {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set - copy server/.env.example to server/.env");

  const url = new URL(raw);
  if (url.protocol !== "mysql:") throw new Error("DATABASE_URL must start with mysql://");
  if (!url.password) throw new Error("DATABASE_URL has no password - add it in server/.env");

  const sslMode = (url.searchParams.get("ssl-mode") ?? "").toUpperCase();
  const caPath = process.env.DATABASE_CA_PATH;

  let ssl: mysql.SslOptions | undefined;
  if (caPath) {
    // Encrypted AND the server's certificate is verified against Aiven's CA. Preferred.
    ssl = { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };
  } else if (sslMode === "REQUIRED" || sslMode === "VERIFY_CA" || sslMode === "VERIFY_IDENTITY") {
    // Matches the MySQL client's ssl-mode=REQUIRED: encrypted, but the certificate is not
    // verified. Set DATABASE_CA_PATH to Aiven's ca.pem to verify it.
    console.warn("[db] TLS is on but unverified - set DATABASE_CA_PATH to verify the server");
    ssl = { rejectUnauthorized: false };
  }

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, "") || undefined,
    ssl,
    connectionLimit: 10,
    // Chip amounts are BIGINT; return them as strings so no precision is lost past 2^53.
    supportBigNumbers: true,
    bigNumberStrings: true,
  };
}

export const pool = mysql.createPool(poolOptions());
