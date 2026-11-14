/**
 * Business-timezone date handling.
 *
 * Document dates are business dates, not device dates: a shop in Karachi posting
 * at 00:30 local time must not create yesterday's sale. The database performs the
 * same conversion from `businesses.timezone` when it rejects a future date.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: string): boolean {
  return ISO_DATE.test(value);
}

/** Current YYYY-MM-DD in the business timezone, falling back to UTC. */
export function isoDateInTimezone(timezone: string, at: Date = new Date()): string {
  try {
    // en-CA is the one common locale whose short date is already ISO-ordered.
    const formatted = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
    if (isValidIsoDate(formatted)) return formatted;
  } catch {
    // An unknown zone must not stop the user from recording a sale.
  }
  return at.toISOString().slice(0, 10);
}

export type DateRange = { from: string; to: string };

/** The whole of the current month in the business timezone. */
export function currentMonthRange(timezone: string, at: Date = new Date()): DateRange {
  const today = isoDateInTimezone(timezone, at);
  const [year, month] = today.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${today.slice(0, 8)}01`,
    to: `${today.slice(0, 8)}${String(lastDay).padStart(2, '0')}`,
  };
}

/** Renders a stored YYYY-MM-DD without a timezone shift: 2026-11-06 -> 6 Nov 2026. */
export function formatDayLabel(isoDate: string | null | undefined): string {
  if (!isoDate || !isValidIsoDate(isoDate)) return '—';
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  return `${day} ${MONTHS[month - 1] ?? ''} ${year}`;
}

/** Short day/month label for compact list rows: 2026-11-06 -> 6 Nov. */
export function formatShortDayLabel(isoDate: string | null | undefined): string {
  if (!isoDate || !isValidIsoDate(isoDate)) return '—';
  const [, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  return `${day} ${MONTHS[month - 1] ?? ''}`;
}

/** Local wall-clock time of a timestamptz in the business timezone. */
export function formatClockLabel(isoTimestamp: string, timezone: string): string {
  const at = new Date(isoTimestamp);
  if (Number.isNaN(at.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
  } catch {
    return at.toISOString().slice(11, 16);
  }
}

export function formatActivityTimestamp(isoTimestamp: string, timezone: string): string {
  const date = isoTimestamp.slice(0, 10);
  const today = isoDateInTimezone(timezone);
  if (date === today) return `Today ${formatClockLabel(isoTimestamp, timezone)}`;
  return `${formatDayLabel(date)} ${formatClockLabel(isoTimestamp, timezone)}`;
}
