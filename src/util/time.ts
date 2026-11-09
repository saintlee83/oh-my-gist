export interface Zoned {
  date: string;
  month: string;
  year: number;
  hour: number;
  /** Monday = 0 ... Sunday = 6 */
  weekday: number;
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, found);
  }
  return found;
}

export function zoned(instant: string | Date, timeZone: string): Zoned {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(date)) parts[part.type] = part.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    month: `${parts.year}-${parts.month}`,
    year: Number(parts.year),
    hour: Number(parts.hour) % 24,
    weekday: WEEKDAY_INDEX[parts.weekday],
  };
}

export function hoursBetween(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000;
}

/** The trailing `count` months ending at `month`, oldest first. */
export function lastMonths(month: string, count: number): string[] {
  const [year, index] = month.split('-').map(Number);
  const out: string[] = [];
  for (let back = count - 1; back >= 0; back--) {
    const date = new Date(Date.UTC(year, index - 1 - back, 1));
    out.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** The trailing `count` calendar days ending at `date`, oldest first. */
export function lastDays(date: string, count: number): string[] {
  const end = new Date(`${date}T00:00:00Z`).getTime();
  const out: string[] = [];
  for (let back = count - 1; back >= 0; back--) {
    out.push(new Date(end - back * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

export function nextDay(date: string): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
