import { NextResponse, type NextRequest } from "next/server";
import type { RowDataPacket } from "mysql2";
import { recordAdminAudit } from "@/app/lib/server/admin-audit";
import { getAdminActor, isSameOrigin } from "@/app/lib/server/admin-session";
import { createId } from "@/app/lib/server/crypto";
import { getDatabase } from "@/app/lib/server/database";

export const runtime = "nodejs";

const categories = new Set(["Slots", "Table", "Instant"]);
const artThemes = new Set(["coral", "lagoon", "mango", "night", "palm", "tide"]);
const statuses = new Set(["DRAFT", "PUBLISHED"]);

type GameRow = RowDataPacket & {
  id: string;
  slug: string;
  name: string;
  category: string;
  studio: string;
  art_theme: string;
  mark: string;
  description: string;
  status: string;
  created_at: Date | string;
};

type NewGame = {
  slug: string;
  name: string;
  category: "Slots" | "Table" | "Instant";
  studio: string;
  artTheme: "coral" | "lagoon" | "mango" | "night" | "palm" | "tide";
  mark: string;
  description: string;
  status: "DRAFT" | "PUBLISHED";
};

function parseGame(value: unknown): NewGame | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const slug = typeof input.slug === "string" ? input.slug.trim().toLowerCase() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const category = input.category;
  const studio = typeof input.studio === "string" ? input.studio.trim() : "";
  const artTheme = input.artTheme;
  const mark = typeof input.mark === "string" ? input.mark.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const status = input.status;

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) return null;
  if (!name || name.length > 120 || !studio || studio.length > 100) return null;
  if (typeof category !== "string" || !categories.has(category)) return null;
  if (typeof artTheme !== "string" || !artThemes.has(artTheme)) return null;
  if (!mark || Array.from(mark).length > 16 || /[\u0000-\u001f<>]/.test(mark)) return null;
  if (description.length > 280) return null;
  if (typeof status !== "string" || !statuses.has(status)) return null;

  return {
    slug,
    name,
    category: category as NewGame["category"],
    studio,
    artTheme: artTheme as NewGame["artTheme"],
    mark,
    description,
    status: status as NewGame["status"],
  };
}

function presentGame(game: GameRow) {
  return {
    id: game.id,
    slug: game.slug,
    name: game.name,
    category: game.category,
    studio: game.studio,
    art: game.art_theme,
    mark: game.mark,
    description: game.description,
    status: game.status,
    createdAt: game.created_at,
  };
}

export async function GET(request: NextRequest) {
  const admin = await getAdminActor(request);
  if (!admin) return NextResponse.json({ error: "Admin session required" }, { status: 401 });

  try {
    const [rows] = await getDatabase().execute<GameRow[]>(
      `SELECT id, slug, name, category, studio, art_theme, mark, description, status, created_at
       FROM luck_cays_games
       ORDER BY created_at DESC, name ASC`,
    );
    return NextResponse.json({ games: rows.map(presentGame) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Game catalog is temporarily unavailable" }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Request origin rejected" }, { status: 403 });
  const admin = await getAdminActor(request);
  if (!admin) return NextResponse.json({ error: "Admin session required" }, { status: 401 });
  if (admin.role !== "SUPER_ADMIN" && admin.role !== "CONTENT_ADMIN") {
    return NextResponse.json({ error: "Insufficient permission" }, { status: 403 });
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const game = parseGame(input);
  if (!game) return NextResponse.json({ error: "Game details are invalid" }, { status: 400 });

  const id = createId();
  const connection = await getDatabase().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO luck_cays_games
       (id, slug, name, category, studio, art_theme, mark, description, status,
        real_money_enabled, created_by_uid, updated_by_uid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [id, game.slug, game.name, game.category, game.studio, game.artTheme, game.mark,
        game.description, game.status, admin.firebaseUid, admin.firebaseUid],
    );
    await recordAdminAudit(connection, admin.firebaseUid, "GAME_CREATED", "game", id, {
      slug: game.slug,
      status: game.status,
      category: game.category,
    });
    await connection.commit();
    return NextResponse.json({ game: { id, ...game, art: game.artTheme, realMoneyEnabled: false } }, { status: 201 });
  } catch (error) {
    await connection.rollback();
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
      return NextResponse.json({ error: "A game with that slug already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: "Could not save the game" }, { status: 503 });
  } finally {
    connection.release();
  }
}
