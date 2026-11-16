/**
 * Wall-clock times in a named timezone ("14:00 in America/Nassau") converted to exact
 * instants, with daylight saving handled by the platform's Intl data - no library needed.
 */

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** How far the zone is ahead of UTC at that instant, in ms (Nassau in summer: -4h). */
function offsetMs(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant at which the zone's clock reads the given date and time. */
function zonedTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  // Date.UTC normalises overflow, so day 0 or day 32 roll into the adjacent month.
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wall - offsetMs(new Date(wall), timeZone);
  // Re-check once: the offset at the guess can differ from the offset at the answer when
  // the two straddle a daylight-saving change.
  const corrected = wall - offsetMs(new Date(instant), timeZone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

function parseHhmm(hhmm: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour > 23 || minute > 59) throw new Error(`Invalid time "${hhmm}", expected HH:MM`);
  return { hour, minute };
}

/** The most recent instant, at or before `now`, when the zone's clock read `hhmm`. */
export function lastDailyTime(now: Date, hhmm: string, timeZone: string): Date {
  const { hour, minute } = parseHhmm(hhmm);
  const today = localParts(now, timeZone);
  const candidate = zonedTimeToInstant(today.year, today.month, today.day, hour, minute, timeZone);
  if (candidate.getTime() <= now.getTime()) return candidate;
  return zonedTimeToInstant(today.year, today.month, today.day - 1, hour, minute, timeZone);
}

/** The next instant, strictly after `now`, when the zone's clock reads `hhmm`. */
export function nextDailyTime(now: Date, hhmm: string, timeZone: string): Date {
  const { hour, minute } = parseHhmm(hhmm);
  const today = localParts(now, timeZone);
  const candidate = zonedTimeToInstant(today.year, today.month, today.day, hour, minute, timeZone);
  if (candidate.getTime() > now.getTime()) return candidate;
  return zonedTimeToInstant(today.year, today.month, today.day + 1, hour, minute, timeZone);
}

/** The zone's calendar date at that instant, as YYYY-MM-DD. */
export function localDateKey(instant: Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
