import { slotConfigSchema, type SlotConfig } from "./types.js";
import { reefRiches } from "./configs/reef-riches.js";
import { krakensDepths } from "./configs/krakens-depths.js";
import { sunkenTemple } from "./configs/sunken-temple.js";

export * from "./types.js";
export * from "./engine.js";
export * from "./exact.js";

/**
 * Every slot the platform ships. Seeded into `slot_games` by `prisma/seed.ts`;
 * at runtime the API reads the config from the database so admins can edit a
 * game without a deploy. This registry is the source the seed starts from.
 */
const registry: SlotConfig[] = [reefRiches, krakensDepths, sunkenTemple];

/**
 * Parse every config at module load. A malformed game config is a startup
 * failure, not a surprise at spin time.
 */
export const slotGames: ReadonlyMap<string, SlotConfig> = new Map(
  registry.map((config) => {
    const parsed = slotConfigSchema.parse(config);
    return [parsed.slug, parsed];
  }),
);

export function getSlotConfig(slug: string): SlotConfig {
  const config = slotGames.get(slug);
  if (!config) throw new Error(`unknown slot game: ${slug}`);
  return config;
}

export function listSlotSlugs(): string[] {
  return [...slotGames.keys()];
}
