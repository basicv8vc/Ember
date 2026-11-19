import type { MisfirePolicy, ScheduleKind } from './schema.js';

export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 2_592_000;

export interface LocalWallClockParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly dow: number; // 0 = Sunday .. 6 = Saturday
  readonly dateKey: string; // YYYY-MM-DD
  readonly slotKey: string; // YYYY-MM-DDTHH:MM
}

interface CronFieldMatcher {
  readonly values: ReadonlySet<number>;
}

export interface ParsedCronExpr {
  readonly minute: CronFieldMatcher;
  readonly hour: CronFieldMatcher;
  readonly dayOfMonth: CronFieldMatcher;
  readonly month: CronFieldMatcher;
  readonly dayOfWeek: CronFieldMatcher;
  readonly dayOfMonthWildcard: boolean;
  readonly dayOfWeekWildcard: boolean;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getTimeZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

export function assertValidIanaTimezone(timeZone: string): void {
  if (timeZone.trim().length === 0) {
    throw new Error('Timezone must be a non-empty IANA timezone identifier');
  }
  getTimeZoneFormatter(timeZone);
}

export function getLocalWallClockParts(utcMs: number, timeZone: string): LocalWallClockParts {
  const parts = getTimeZoneFormatter(timeZone).formatToParts(new Date(utcMs));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let dow = 0;

  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number.parseInt(part.value, 10);
        break;
      case 'month':
        month = Number.parseInt(part.value, 10);
        break;
      case 'day':
        day = Number.parseInt(part.value, 10);
        break;
      case 'hour':
        hour = Number.parseInt(part.value, 10) % 24;
        break;
      case 'minute':
        minute = Number.parseInt(part.value, 10);
        break;
      case 'second':
        second = Number.parseInt(part.value, 10);
        break;
      case 'weekday': {
        const mapped = WEEKDAY_MAP[part.value];
        if (mapped === undefined) {
          throw new Error(`Unexpected weekday value '${part.value}'`);
        }
        dow = mapped;
        break;
      }
      default:
        break;
    }
  }

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const hh = String(hour).padStart(2, '0');
  const min = String(minute).padStart(2, '0');
  const dateKey = `${year}-${mm}-${dd}`;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dow,
    dateKey,
    slotKey: `${dateKey}T${hh}:${min}`,
  };
}

function parseCronField(
  token: string,
  min: number,
  max: number,
  mapSevenToZero = false,
): CronFieldMatcher {
  const values = new Set<number>();
  const segments = token.split(',');

  for (const segment of segments) {
    const [rangePart, stepPart] = segment.split('/');
    if (rangePart === undefined || segment.split('/').length > 2) {
      throw new Error(`Invalid cron field segment '${segment}'`);
    }
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isSafeInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step '${String(stepPart)}' in '${segment}'`);
    }

    let start = min;
    let end = max;
    if (rangePart !== '*') {
      const [rawStart, rawEnd] = rangePart.split('-');
      if (rawStart === undefined || rangePart.split('-').length > 2) {
        throw new Error(`Invalid cron range '${rangePart}'`);
      }
      start = Number.parseInt(rawStart, 10);
      end = rawEnd === undefined ? start : Number.parseInt(rawEnd, 10);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < min ||
        end > max + (mapSevenToZero ? 1 : 0) ||
        start > end
      ) {
        throw new Error(`Out-of-bounds cron range '${rangePart}' for [${min}..${max}]`);
      }
    }

    for (let value = start; value <= end; value += step) {
      values.add(mapSevenToZero && value === 7 ? 0 : value);
    }
  }

  if (values.size === 0) {
    throw new Error(`Empty cron field '${token}'`);
  }
  return { values };
}

export function parseCronExpression(expr: string): ParsedCronExpr {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Expected 5-field cron expression, got '${expr}'`);
  }
  const [minTok, hourTok, domTok, monthTok, dowTok] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    minute: parseCronField(minTok, 0, 59),
    hour: parseCronField(hourTok, 0, 23),
    dayOfMonth: parseCronField(domTok, 1, 31),
    month: parseCronField(monthTok, 1, 12),
    dayOfWeek: parseCronField(dowTok, 0, 6, true),
    dayOfMonthWildcard: domTok === '*',
    dayOfWeekWildcard: dowTok === '*',
  };
}

function localCalendarDayMatchesCron(
  parsed: ParsedCronExpr,
  year: number,
  month: number,
  day: number,
): boolean {
  if (!parsed.month.values.has(month)) {
    return false;
  }
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const domMatch = parsed.dayOfMonth.values.has(day);
  const dowMatch = parsed.dayOfWeek.values.has(dow);

  if (parsed.dayOfMonthWildcard && parsed.dayOfWeekWildcard) {
    return true;
  }
  if (parsed.dayOfMonthWildcard) {
    return dowMatch;
  }
  if (parsed.dayOfWeekWildcard) {
    return domMatch;
  }
  // Standard Vixie cron: if neither DOM nor DOW is wildcard, either match qualifies
  return domMatch || dowMatch;
}

function toLocalWallClockMinutes(parts: Pick<LocalWallClockParts, 'hour' | 'minute'>): number {
  return parts.hour * 60 + parts.minute;
}

function resolveZonedSlotUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): { readonly utcMs: number; readonly springForwardResolved: boolean } | null {
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const probeParts = getLocalWallClockParts(naiveUtcMs, timeZone);
  const probeAsNaiveUtc = Date.UTC(
    probeParts.year,
    probeParts.month - 1,
    probeParts.day,
    probeParts.hour,
    probeParts.minute,
    0,
    0,
  );
  const estimatedOffsetMs = probeAsNaiveUtc - naiveUtcMs;
  const guessUtcMs = naiveUtcMs - estimatedOffsetMs;

  // Check nearby minute offsets (-90m..+90m handle standard/half-hour/1h DST shifts accurately)
  const targetMinutes = hour * 60 + minute;
  const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  // Search earlier candidate first so fall-back overlap selects the FIRST occurrence
  const matchingInstants: number[] = [];
  for (const shiftMinutes of [-60, -30, 0, 30, 60]) {
    const candidate = guessUtcMs + shiftMinutes * 60_000;
    const p = getLocalWallClockParts(candidate, timeZone);
    if (p.dateKey === dateKey && p.hour === hour && p.minute === minute) {
      matchingInstants.push(candidate);
    }
  }
  if (matchingInstants.length > 0) {
    return {
      utcMs: Math.min(...matchingInstants),
      springForwardResolved: false,
    };
  }

  // Handle spring-forward gap: find the exact first instant on `dateKey` where wall-clock jumps >= targetMinutes
  let firstValidAfterGap: number | null = null;
  for (let deltaMin = -90; deltaMin <= 90; deltaMin += 1) {
    const t = guessUtcMs + deltaMin * 60_000;
    const p = getLocalWallClockParts(t, timeZone);
    if (p.dateKey === dateKey && toLocalWallClockMinutes(p) >= targetMinutes) {
      firstValidAfterGap = t;
      break;
    }
  }
  if (firstValidAfterGap !== null) {
    return {
      utcMs: firstValidAfterGap,
      springForwardResolved: true,
    };
  }

  return null;
}

export function findNextCronTzFireAtMs(cmd: {
  readonly cronExpr: string;
  readonly timezone: string;
  readonly afterUtcMs: number;
  readonly lastFiredAtMs: number | null;
  readonly maxLookaheadDays?: number;
}): number {
  assertValidIanaTimezone(cmd.timezone);
  const parsed = parseCronExpression(cmd.cronExpr);
  const maxDays = cmd.maxLookaheadDays ?? 400;

  const sortedHours = [...parsed.hour.values].sort((a, b) => a - b);
  const sortedMinutes = [...parsed.minute.values].sort((a, b) => a - b);

  const lastFiredSlotKey =
    cmd.lastFiredAtMs !== null
      ? getLocalWallClockParts(cmd.lastFiredAtMs, cmd.timezone).slotKey
      : null;

  const startLocal = getLocalWallClockParts(cmd.afterUtcMs, cmd.timezone);

  for (let dayOffset = 0; dayOffset <= maxDays; dayOffset += 1) {
    const refDate = new Date(
      Date.UTC(startLocal.year, startLocal.month - 1, startLocal.day + dayOffset),
    );
    const y = refDate.getUTCFullYear();
    const m = refDate.getUTCMonth() + 1;
    const d = refDate.getUTCDate();

    if (!localCalendarDayMatchesCron(parsed, y, m, d)) {
      continue;
    }

    for (const h of sortedHours) {
      for (const min of sortedMinutes) {
        const resolved = resolveZonedSlotUtcMs(y, m, d, h, min, cmd.timezone);
        if (resolved === null || resolved.utcMs <= cmd.afterUtcMs) {
          continue;
        }
        const resolvedParts = getLocalWallClockParts(resolved.utcMs, cmd.timezone);
        if (lastFiredSlotKey !== null && resolvedParts.slotKey === lastFiredSlotKey) {
          // Fall-back deduplication: do not double-fire the same wall-clock slot on overlap hour
          continue;
        }
        return resolved.utcMs;
      }
    }
  }

  throw new Error(`No matching cron occurrence found within ${maxDays} days for '${cmd.cronExpr}'`);
}

export function computeNextScheduleFireAtMs(cmd: {
  readonly scheduleKind: ScheduleKind;
  readonly intervalSeconds: number | null;
  readonly cronExpr: string | null;
  readonly timezone: string;
  readonly currentNextFireAtMs: number;
  readonly misfirePolicy: MisfirePolicy;
  readonly nowMs: number;
}): { readonly nextFireAtMs: number | null; readonly newStatus: 'active' | 'completed' } {
  if (cmd.scheduleKind === 'once') {
    return { nextFireAtMs: null, newStatus: 'completed' };
  }

  if (cmd.scheduleKind === 'interval') {
    const intervalSec = cmd.intervalSeconds;
    if (
      intervalSec === null ||
      !Number.isSafeInteger(intervalSec) ||
      intervalSec < MIN_INTERVAL_SECONDS ||
      intervalSec > MAX_INTERVAL_SECONDS
    ) {
      throw new Error(
        `Invalid intervalSeconds=${String(intervalSec)} (expected [${MIN_INTERVAL_SECONDS}..${MAX_INTERVAL_SECONDS}])`,
      );
    }
    const stepMs = intervalSec * 1_000;
    let next = cmd.currentNextFireAtMs + stepMs;
    if (cmd.misfirePolicy === 'coalesce_latest' || cmd.misfirePolicy === 'skip_missed') {
      if (next <= cmd.nowMs) {
        const missedSteps = Math.floor((cmd.nowMs - next) / stepMs) + 1;
        next += missedSteps * stepMs;
      }
    }
    return { nextFireAtMs: next, newStatus: 'active' };
  }

  if (cmd.cronExpr === null) {
    throw new Error('cron_tz schedule requires non-null cronExpr');
  }

  const anchorMs =
    cmd.misfirePolicy === 'coalesce_latest' || cmd.misfirePolicy === 'skip_missed'
      ? Math.max(cmd.nowMs, cmd.currentNextFireAtMs)
      : cmd.currentNextFireAtMs;

  const nextFireAtMs = findNextCronTzFireAtMs({
    cronExpr: cmd.cronExpr,
    timezone: cmd.timezone,
    afterUtcMs: anchorMs,
    lastFiredAtMs: cmd.currentNextFireAtMs,
  });

  return { nextFireAtMs, newStatus: 'active' };
}
