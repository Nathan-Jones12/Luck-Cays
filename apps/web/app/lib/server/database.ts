import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import mysql, { type Pool } from "mysql2/promise";

let pool: Pool | undefined;

export function getDatabase(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured");

  const url = new URL(connectionString);
  if (url.protocol !== "mysql:") throw new Error("DATABASE_URL must use the mysql protocol");

  const caPath = process.env.MYSQL_SSL_CA;
  const ssl = {
    rejectUnauthorized: true,
    ...(caPath ? { ca: readFileSync(resolve(/*turbopackIgnore: true*/ process.cwd(), caPath)) } : {}),
  };

  pool = mysql.createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl,
    waitForConnections: true,
    connectionLimit: 8,
    queueLimit: 0,
    enableKeepAlive: true,
    multipleStatements: false,
  });

  return pool;
}
