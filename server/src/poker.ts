import type { Express } from "express";
import type { RowDataPacket } from "mysql2/promise";
import type { Server } from "socket.io";
import { pool } from "./db.js";

interface PokerTableRow extends RowDataPacket {
  id: string;
  name: string;
  maxSeats: number;
  smallBlind: string;
  bigBlind: string;
  minBuyin: string;
  maxBuyin: string;
  isActive: number;
  seatedCount?: number;
}

interface PokerSeatRow extends RowDataPacket {
  seatNo: number;
  userId: string | null;
  username: string | null;
  stack: string;
  sittingOut: number;
}

function tableSummary(row: PokerTableRow) {
  return {
    id: row.id,
    name: row.name,
    maxSeats: row.maxSeats,
    smallBlind: String(row.smallBlind),
    bigBlind: String(row.bigBlind),
    minBuyin: String(row.minBuyin),
    maxBuyin: String(row.maxBuyin),
    seatedCount: Number(row.seatedCount ?? 0),
    isActive: Boolean(row.isActive),
  };
}

export function registerPokerRoutes(app: Express): void {
  app.get("/api/poker/tables", async (_req, res) => {
    try {
      const [rows] = await pool.query<PokerTableRow[]>(
        `SELECT t.id, t.name, t.max_seats AS maxSeats,
                CAST(t.small_blind AS CHAR) AS smallBlind,
                CAST(t.big_blind AS CHAR) AS bigBlind,
                CAST(t.min_buyin AS CHAR) AS minBuyin,
                CAST(t.max_buyin AS CHAR) AS maxBuyin,
                t.is_active AS isActive,
                COUNT(s.user_id) AS seatedCount
         FROM poker_tables t
         LEFT JOIN poker_seats s ON s.table_id = t.id AND s.user_id IS NOT NULL
         WHERE t.is_active = TRUE
         GROUP BY t.id
         ORDER BY t.small_blind, t.name`,
      );
      res.json({ tables: rows.map(tableSummary) });
    } catch (err) {
      console.error("[poker] table list failed:", err);
      res.status(500).json({ error: "Could not load poker tables" });
    }
  });

  app.get("/api/poker/tables/:tableId", async (req, res) => {
    try {
      const [tables] = await pool.query<PokerTableRow[]>(
        `SELECT id, name, max_seats AS maxSeats,
                CAST(small_blind AS CHAR) AS smallBlind,
                CAST(big_blind AS CHAR) AS bigBlind,
                CAST(min_buyin AS CHAR) AS minBuyin,
                CAST(max_buyin AS CHAR) AS maxBuyin,
                is_active AS isActive
         FROM poker_tables
         WHERE id = ? AND is_active = TRUE`,
        [req.params.tableId],
      );
      const table = tables[0];
      if (!table) {
        res.status(404).json({ error: "Poker table not found" });
        return;
      }

      const [seats] = await pool.query<PokerSeatRow[]>(
        `SELECT s.seat_no AS seatNo, s.user_id AS userId, u.username,
                CAST(s.stack AS CHAR) AS stack, s.sitting_out AS sittingOut
         FROM poker_seats s
         LEFT JOIN users u ON u.id = s.user_id
         WHERE s.table_id = ?
         ORDER BY s.seat_no`,
        [table.id],
      );
      const seated = new Map(seats.map((seat) => [seat.seatNo, seat]));
      const view = {
        tableId: table.id,
        handId: null,
        street: null,
        board: [],
        pots: [],
        smallBlind: String(table.smallBlind),
        bigBlind: String(table.bigBlind),
        legalActions: [],
        yourSeat: null,
        seats: Array.from({ length: table.maxSeats }, (_, seatNo) => {
          const seat = seated.get(seatNo);
          return {
            seatNo,
            userId: seat?.userId ?? null,
            username: seat?.username ?? null,
            stack: String(seat?.stack ?? "0"),
            committed: "0",
            folded: false,
            allIn: false,
            sittingOut: Boolean(seat?.sittingOut),
            isDealer: false,
            isTurn: false,
            holeCards: null,
            timeLeftMs: null,
          };
        }),
      };
      res.json({ table: view });
    } catch (err) {
      console.error("[poker] table snapshot failed:", err);
      res.status(500).json({ error: "Could not load poker table" });
    }
  });
}

export function registerPokerSockets(io: Server): void {
  io.on("connection", (socket) => {
    const rejectUntilReady = () => {
      socket.emit("poker:error", {
        code: "POKER_NOT_READY",
        message: "Poker actions are not available until backend authentication and game logic are configured.",
      });
    };

    socket.on("poker:join", rejectUntilReady);
    socket.on("poker:leave", rejectUntilReady);
    socket.on("poker:sitOut", rejectUntilReady);
    socket.on("poker:action", rejectUntilReady);
  });
}
