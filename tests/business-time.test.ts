import {
  currentMonthRange,
  formatActivityTimestamp,
  formatClockLabel,
  formatDayLabel,
  formatShortDayLabel,
  isoDateInTimezone,
  isValidIsoDate,
} from '../src/lib/business-time';

/**
 * Document dates belong to the business, not to the device: a shop in Karachi
 * posting at 00:30 local time must not create yesterday's sale, and a stored
 * YYYY-MM-DD must never be shifted by a day when it is rendered.
 */
describe('business-timezone dates', () => {
  const lateUtc = new Date('2026-11-06T20:30:00Z');

  it('converts an instant to the business day', () => {
    expect(isoDateInTimezone('UTC', lateUtc)).toBe('2026-11-06');
    // Karachi is UTC+5, so 20:30Z is already 01:30 the next morning.
    expect(isoDateInTimezone('Asia/Karachi', lateUtc)).toBe('2026-11-07');
    expect(isoDateInTimezone('America/New_York', lateUtc)).toBe('2026-11-06');
    // Kiritimati is UTC+14, the first place on earth to see the day.
    expect(isoDateInTimezone('Pacific/Kiritimati', lateUtc)).toBe('2026-11-07');
    // Niue is UTC-11, the last.
    expect(isoDateInTimezone('Pacific/Niue', lateUtc)).toBe('2026-11-06');
  });

  it('falls back to UTC for a timezone the device does not know', () => {
    expect(isoDateInTimezone('Mars/Olympus_Mons', lateUtc)).toBe('2026-11-06');
    expect(isoDateInTimezone('', lateUtc)).toBe('2026-11-06');
  });

  it('spans the whole current month, including leap years', () => {
    expect(currentMonthRange('UTC', new Date('2026-11-06T09:00:00Z'))).toEqual({
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(currentMonthRange('UTC', new Date('2026-02-10T09:00:00Z'))).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(currentMonthRange('UTC', new Date('2028-02-10T09:00:00Z'))).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
    expect(currentMonthRange('UTC', new Date('2026-12-31T23:30:00Z'))).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
    // The same instant is already January in Karachi.
    expect(currentMonthRange('Asia/Karachi', new Date('2026-12-31T23:30:00Z'))).toEqual({
      from: '2027-01-01',
      to: '2027-01-31',
    });
  });

  it('renders a stored date without moving it', () => {
    expect(formatDayLabel('2026-11-06')).toBe('6 Nov 2026');
    expect(formatDayLabel('2026-01-01')).toBe('1 Jan 2026');
    expect(formatDayLabel('2026-12-31')).toBe('31 Dec 2026');
    expect(formatShortDayLabel('2026-11-06')).toBe('6 Nov');
    expect(formatDayLabel(null)).toBe('—');
    expect(formatDayLabel(undefined)).toBe('—');
    expect(formatDayLabel('not-a-date')).toBe('—');
  });

  it('shows wall-clock time in the business timezone', () => {
    expect(formatClockLabel('2026-11-06T20:30:00Z', 'UTC')).toBe('20:30');
    expect(formatClockLabel('2026-11-06T20:30:00Z', 'Asia/Karachi')).toBe('01:30');
    expect(formatClockLabel('not-a-timestamp', 'UTC')).toBe('—');
  });

  it('labels recent activity by day and time', () => {
    expect(formatActivityTimestamp('2020-01-02T03:04:05Z', 'UTC')).toBe('2 Jan 2020 03:04');
    const now = new Date().toISOString();
    const timezone = 'UTC';
    const label = formatActivityTimestamp(now, timezone);
    // Today in UTC may differ from today on the test machine by a few hours, so
    // accept either the "Today" form or the explicit date form.
    expect(
      label === `Today ${formatClockLabel(now, timezone)}` ||
        label.startsWith(formatDayLabel(now.slice(0, 10))),
    ).toBe(true);
  });

  it('accepts only real ISO dates', () => {
    for (const good of ['2026-11-06', '2000-01-01', '2999-12-31'])
      expect(isValidIsoDate(good)).toBe(true);
    for (const bad of [
      '',
      '2026-1-1',
      '2026-11-06T00:00:00Z',
      '06-11-2026',
      '2026/11/06',
      'abcdefghij',
    ])
      expect(isValidIsoDate(bad)).toBe(false);
  });
});
