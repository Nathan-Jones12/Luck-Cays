/**
 * Fixture sync.
 *
 * With `SPORTS_API_KEY` set, this pulls fixtures and odds from The Odds API. Without one
 * it generates a deterministic set of demo fixtures instead, so the sportsbook is
 * populated and playable with no third-party account - which is what the prototype needs.
 *
 * Both paths converge on `upsertEvent`, so the demo data exercises exactly the same
 * storage and settlement code as live data would.
 */
import { env } from "../../lib/env.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { oddsToInt, setEventResult } from "./sports.service.js";

interface MarketInput {
  type: "moneyline" | "spread" | "totals";
  /** Empty string for moneyline, which has no line. */
  line: string;
  selections: Array<{ key: string; label: string; odds: string }>;
}

interface EventInput {
  providerId: string;
  sport: string;
  league: string;
  home: string;
  away: string;
  startsAt: Date;
  markets: MarketInput[];
}

/**
 * Upsert an event and replace its markets.
 *
 * Markets are matched on (event, type, line) so re-running the sync updates prices rather
 * than duplicating them, and bets already placed keep pointing at the right market with
 * the odds they were struck at.
 */
async function upsertEvent(input: EventInput): Promise<void> {
  const event = await prisma.sportsEvent.upsert({
    where: { providerId: input.providerId },
    create: {
      providerId: input.providerId,
      sport: input.sport,
      league: input.league,
      home: input.home,
      away: input.away,
      startsAt: input.startsAt,
      status: "scheduled",
    },
    update: { startsAt: input.startsAt },
    select: { id: true },
  });

  for (const market of input.markets) {
    const selectionsJson = JSON.stringify(
      market.selections.map((selection) => ({
        key: selection.key,
        label: selection.label,
        oddsInt: oddsToInt(selection.odds),
      })),
    );

    await prisma.sportsMarket.upsert({
      where: {
        eventId_type_line: { eventId: event.id, type: market.type, line: market.line },
      },
      create: {
        eventId: event.id,
        type: market.type,
        line: market.line,
        selectionsJson,
        status: "open",
      },
      // Never reopen a settled market just because the sync saw it again.
      update: { selectionsJson },
    });
  }
}

/* ------------------------------- demo fixtures ------------------------------ */

const DEMO_FIXTURES: Array<{
  sport: string;
  league: string;
  home: string;
  away: string;
  /** Hours from now. */
  inHours: number;
  homeOdds: string;
  drawOdds: string | null;
  awayOdds: string;
  spread: string;
  total: string;
}> = [
  {
    sport: "Football",
    league: "Premier League",
    home: "Harbour Rovers",
    away: "Cayside United",
    inHours: 6,
    homeOdds: "2.10",
    drawOdds: "3.40",
    awayOdds: "3.25",
    spread: "-0.5",
    total: "2.5",
  },
  {
    sport: "Football",
    league: "Premier League",
    home: "Reef Athletic",
    away: "Port Albion",
    inHours: 28,
    homeOdds: "1.75",
    drawOdds: "3.60",
    awayOdds: "4.50",
    spread: "-1.5",
    total: "3.5",
  },
  {
    sport: "Football",
    league: "La Liga",
    home: "Isla Verde",
    away: "Real Tortuga",
    inHours: 52,
    homeOdds: "2.45",
    drawOdds: "3.20",
    awayOdds: "2.80",
    spread: "-0.5",
    total: "2.5",
  },
  {
    sport: "Basketball",
    league: "NBA",
    home: "Coral Bay Tide",
    away: "Anchor City Kings",
    inHours: 9,
    homeOdds: "1.85",
    drawOdds: null,
    awayOdds: "1.95",
    spread: "-2.5",
    total: "221.5",
  },
  {
    sport: "Basketball",
    league: "NBA",
    home: "Lagoon Heat",
    away: "Windward Storm",
    inHours: 33,
    homeOdds: "1.60",
    drawOdds: null,
    awayOdds: "2.35",
    spread: "-5.5",
    total: "214.5",
  },
  {
    sport: "Tennis",
    league: "ATP Tour",
    home: "M. Castellan",
    away: "J. Oduya",
    inHours: 15,
    homeOdds: "1.55",
    drawOdds: null,
    awayOdds: "2.50",
    spread: "-2.5",
    total: "22.5",
  },
  {
    sport: "Ice Hockey",
    league: "NHL",
    home: "Saltfish Mariners",
    away: "Northpoint Frost",
    inHours: 21,
    homeOdds: "2.05",
    drawOdds: null,
    awayOdds: "1.80",
    spread: "-1.5",
    total: "5.5",
  },
  {
    sport: "Baseball",
    league: "MLB",
    home: "Cays Dockers",
    away: "Trade Wind Sox",
    inHours: 44,
    homeOdds: "1.95",
    drawOdds: null,
    awayOdds: "1.90",
    spread: "-1.5",
    total: "8.5",
  },
];

/**
 * Seed the demo book. Deterministic provider ids, so this is idempotent and re-running it
 * refreshes kick-off times rather than piling up fixtures.
 */
export async function syncDemoFixtures(): Promise<number> {
  const now = Date.now();

  for (const [index, fixture] of DEMO_FIXTURES.entries()) {
    const moneylineSelections = [
      { key: "home", label: fixture.home, odds: fixture.homeOdds },
      ...(fixture.drawOdds ? [{ key: "draw", label: "Draw", odds: fixture.drawOdds }] : []),
      { key: "away", label: fixture.away, odds: fixture.awayOdds },
    ];

    await upsertEvent({
      providerId: `demo-${index + 1}`,
      sport: fixture.sport,
      league: fixture.league,
      home: fixture.home,
      away: fixture.away,
      startsAt: new Date(now + fixture.inHours * 3_600_000),
      markets: [
        { type: "moneyline", line: "", selections: moneylineSelections },
        {
          type: "spread",
          line: fixture.spread,
          selections: [
            { key: "home", label: `${fixture.home} ${fixture.spread}`, odds: "1.90" },
            {
              key: "away",
              label: `${fixture.away} ${fixture.spread.startsWith("-") ? "+" : "-"}${fixture.spread.replace("-", "")}`,
              odds: "1.90",
            },
          ],
        },
        {
          type: "totals",
          line: fixture.total,
          selections: [
            { key: "over", label: `Over ${fixture.total}`, odds: "1.87" },
            { key: "under", label: `Under ${fixture.total}`, odds: "1.93" },
          ],
        },
      ],
    });
  }

  logger.info({ count: DEMO_FIXTURES.length }, "demo fixtures synced");
  return DEMO_FIXTURES.length;
}

/* -------------------------------- live sync -------------------------------- */

/** The subset of The Odds API's response this uses. */
interface OddsApiEvent {
  id: string;
  sport_title: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: Array<{
    markets?: Array<{
      key: string;
      outcomes?: Array<{ name: string; price: number; point?: number }>;
    }>;
  }>;
}

function toOddsString(price: number): string {
  // The API gives decimal odds as a float; two places is the precision we store.
  return price.toFixed(2);
}

/**
 * Pull fixtures from The Odds API.
 *
 * Odds come from the provider where available. The PRD allows admin-entered odds
 * otherwise, which is what the admin market editor is for; a market this sync cannot
 * price is simply skipped rather than invented.
 */
export async function syncFromProvider(sportKey = "upcoming"): Promise<number> {
  if (!env.SPORTS_API_KEY) {
    logger.info("SPORTS_API_KEY not set - seeding demo fixtures instead");
    return syncDemoFixtures();
  }

  const url = new URL(`${env.SPORTS_API_BASE}/sports/${sportKey}/odds`);
  url.searchParams.set("apiKey", env.SPORTS_API_KEY);
  url.searchParams.set("regions", "uk");
  url.searchParams.set("markets", "h2h,spreads,totals");
  url.searchParams.set("oddsFormat", "decimal");

  let payload: OddsApiEvent[];
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      logger.error({ status: response.status }, "sports provider returned an error");
      return 0;
    }
    payload = (await response.json()) as OddsApiEvent[];
  } catch (error) {
    // A provider outage must not take the job down; the next run will try again.
    logger.error({ err: error }, "sports provider request failed");
    return 0;
  }

  let imported = 0;

  for (const event of payload) {
    const bookmaker = event.bookmakers?.[0];
    if (!bookmaker) continue;

    const markets: MarketInput[] = [];

    const h2h = bookmaker.markets?.find((market) => market.key === "h2h");
    if (h2h?.outcomes && h2h.outcomes.length >= 2) {
      markets.push({
        type: "moneyline",
        line: "",
        selections: h2h.outcomes.map((outcome) => ({
          key:
            outcome.name === event.home_team
              ? "home"
              : outcome.name === event.away_team
                ? "away"
                : "draw",
          label: outcome.name,
          odds: toOddsString(outcome.price),
        })),
      });
    }

    const spreads = bookmaker.markets?.find((market) => market.key === "spreads");
    const homeSpread = spreads?.outcomes?.find((outcome) => outcome.name === event.home_team);
    if (spreads?.outcomes && homeSpread?.point !== undefined) {
      markets.push({
        type: "spread",
        line: String(homeSpread.point),
        selections: spreads.outcomes.map((outcome) => ({
          key: outcome.name === event.home_team ? "home" : "away",
          label: `${outcome.name} ${outcome.point ?? ""}`.trim(),
          odds: toOddsString(outcome.price),
        })),
      });
    }

    const totals = bookmaker.markets?.find((market) => market.key === "totals");
    const totalPoint = totals?.outcomes?.[0]?.point;
    if (totals?.outcomes && totalPoint !== undefined) {
      markets.push({
        type: "totals",
        line: String(totalPoint),
        selections: totals.outcomes.map((outcome) => ({
          key: outcome.name.toLowerCase() === "over" ? "over" : "under",
          label: `${outcome.name} ${outcome.point ?? ""}`.trim(),
          odds: toOddsString(outcome.price),
        })),
      });
    }

    if (markets.length === 0) continue;

    await upsertEvent({
      providerId: event.id,
      sport: event.sport_title,
      league: event.sport_title,
      home: event.home_team,
      away: event.away_team,
      startsAt: new Date(event.commence_time),
      markets,
    });
    imported += 1;
  }

  logger.info({ imported }, "fixtures synced from provider");
  return imported;
}

/**
 * Demo helper: finish any fixture whose start time has passed, with a plausible score, so
 * the settlement job has something to grade. Only ever used without a live provider -
 * real results come from the API.
 */
export async function finishDueDemoEvents(): Promise<number> {
  if (env.SPORTS_API_KEY) return 0;

  const due = await prisma.sportsEvent.findMany({
    where: {
      status: "scheduled",
      startsAt: { lte: new Date() },
      providerId: { startsWith: "demo-" },
    },
    select: { id: true, sport: true },
  });

  for (const event of due) {
    // crypto is not needed here: this is demo scaffolding, not an outcome anyone is paid
    // on from a wager the house priced. Scores are drawn from a plausible range per sport.
    const { randomInt } = await import("node:crypto");
    const ranges: Record<string, [number, number]> = {
      Football: [0, 4],
      Basketball: [95, 130],
      Tennis: [0, 3],
      "Ice Hockey": [0, 6],
      Baseball: [0, 9],
    };
    const [low, high] = ranges[event.sport] ?? [0, 5];

    await setEventResult(event.id, {
      homeScore: low + randomInt(high - low + 1),
      awayScore: low + randomInt(high - low + 1),
    });
  }

  if (due.length > 0) logger.info({ count: due.length }, "demo events finished");
  return due.length;
}
