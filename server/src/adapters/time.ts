const WINDOWS_TO_IANA_TZ: Record<string, string> = {
  UTC: 'UTC',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Singapore Standard Time': 'Asia/Singapore',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'India Standard Time': 'Asia/Kolkata',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
};

export function resolveTimeZone(rawTz: unknown, fallbackTz: string): string {
  if (typeof rawTz !== 'string' || !rawTz.trim()) {
    return fallbackTz;
  }
  const candidate = WINDOWS_TO_IANA_TZ[rawTz.trim()] ?? rawTz.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return fallbackTz;
  }
}

function getTimeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = Number(p.value);
    }
  }
  const hour = map['hour'] === 24 ? 0 : (map['hour'] ?? 0);
  const asUtc = Date.UTC(
    map['year'] ?? 1970,
    (map['month'] ?? 1) - 1,
    map['day'] ?? 1,
    hour,
    map['minute'] ?? 0,
    map['second'] ?? 0,
  );
  return asUtc - utcMs;
}

export function extractDateOnly(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  return match ? match[1]! : null;
}

export function parseIsoDateTimeToUnixSec(
  raw: unknown,
  defaultTimezone: string,
): number | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  // Đã có Z hoặc offset (+HH:MM / -HH:MM / +HHMM)
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    const normalized = trimmed.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }

  // Dạng giờ nổi không có múi giờ: YYYY-MM-DDTHH:MM(:SS)?
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? '0');

  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = getTimeZoneOffsetMs(guessUtcMs, defaultTimezone);
  const utcMs1 = guessUtcMs - offset1;
  const offset2 = getTimeZoneOffsetMs(utcMs1, defaultTimezone);
  return Math.floor((guessUtcMs - offset2) / 1000);
}

export function parseMicrosoftDateTime(
  dtObj: unknown,
  fallbackTimezone: string,
): number | null {
  if (!dtObj || typeof dtObj !== 'object') {
    return null;
  }
  const rec = dtObj as Record<string, unknown>;
  const tz = resolveTimeZone(rec['timeZone'], fallbackTimezone);
  return parseIsoDateTimeToUnixSec(rec['dateTime'], tz);
}

export function formatLocalDateTime(epochSec: number, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return dtf.format(new Date(epochSec * 1000));
}
