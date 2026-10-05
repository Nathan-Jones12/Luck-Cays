import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { getDatabase } from "@/app/lib/server/database";

export const runtime = "nodejs";

 type PublicGameRow = RowDataPacket & {
  id: string;
  slug: string;
  name: string;
  category: "Slots" | "Table" | "Instant";
  studio: string;
  art_theme: string;
  mark: string;
  description: string;
};

export async function GET() {
  try {
    const [rows] = await getDatabase().execute<PublicGameRow[]>(
      `SELECT id, slug, name, category, studio, art_theme, mark, description
       FROM luck_cays_games
       WHERE status = 'PUBLISHED' AND real_money_enabled = 0
       ORDER BY created_at DESC, name ASC`,
    );
    return NextResponse.json({ games: rows.map((game) => ({
      id: game.id,
      slug: game.slug,
      name: game.name,
      category: game.category,
      studio: game.studio,
      art: game.art_theme,
      mark: game.mark,
      description: game.description,
    })) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Game catalog is temporarily unavailable" }, { status: 503 });
  }
}
