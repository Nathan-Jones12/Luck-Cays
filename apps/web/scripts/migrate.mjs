import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import nextEnv from "@next/env";
import mysql from "mysql2/promise";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is not configured");

const url = new URL(connectionString);
if (url.protocol !== "mysql:") throw new Error("DATABASE_URL must use the mysql protocol");

const caPath = process.env.MYSQL_SSL_CA;
const ssl = {
  rejectUnauthorized: true,
  ...(caPath ? { ca: readFileSync(resolve(process.cwd(), caPath)) } : {}),
};
const connection = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: decodeURIComponent(url.pathname.slice(1)),
  ssl,
  connectTimeout: 15000,
  multipleStatements: false,
});

try {
  await connection.query(`CREATE TABLE IF NOT EXISTS luck_cays_schema_migrations (
    version VARCHAR(128) NOT NULL,
    applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (version)
  ) ENGINE=InnoDB`);

  const directory = resolve(process.cwd(), "..", "..", "database", "migrations");
  const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    const [rows] = await connection.execute("SELECT version FROM luck_cays_schema_migrations WHERE version = ?", [file]);
    if (rows.length) {
      console.log(`Already applied: ${file}`);
      continue;
    }

    const statements = readFileSync(resolve(directory, file), "utf8")
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) await connection.query(statement);
    await connection.execute("INSERT INTO luck_cays_schema_migrations (version) VALUES (?)", [file]);
    console.log(`Applied: ${file}`);
  }
} finally {
  await connection.end();
}
