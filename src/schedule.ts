import { SCHEDULE_HOUR, SCHEDULE_TIMEZONE } from './config.ts';

/**
 * GitHub Actions cron only speaks UTC, and America/Chicago shifts between
 * UTC-6 (CST) and UTC-5 (CDT). A single UTC cron entry would therefore drift an
 * hour twice a year. The workflow schedules BOTH 06:00 and 07:00 UTC and this
 * gate lets exactly one of them through: the one that is actually 1am in
 * Chicago on that date.
 */
export function localHourIn(tz: string, at: Date): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  }).format(at);
  // Intl renders midnight as "24" in some ICU versions; normalise to 0.
  return Number(formatted) % 24;
}

/**
 * True only for the FIRST occurrence of the target local hour.
 *
 * On the autumn fall-back date (e.g. 1 Nov 2026) America/Chicago passes through
 * 1am twice — once at 06:00Z in CDT and again at 07:00Z in CST — so both cron
 * entries would otherwise fire and the fleet would be reconciled twice in one
 * night. Looking one hour back tells us whether we are the repeat, which keeps
 * the guard stateless: no lock, no marker file, no external store.
 */
export function isScheduledHour(at: Date, tz: string = SCHEDULE_TIMEZONE, hour: number = SCHEDULE_HOUR): boolean {
  if (localHourIn(tz, at) !== hour) return false;
  const anHourEarlier = new Date(at.getTime() - 3_600_000);
  return localHourIn(tz, anHourEarlier) !== hour;
}

/** Hours a PR has been open, as of `now`. */
export function hoursOpen(createdAt: string, now: Date): number {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) {
    throw new Error(`unparseable PR createdAt: ${createdAt}`);
  }
  return (now.getTime() - created) / 3_600_000;
}
