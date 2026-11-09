const PARTIALS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Width as a terminal or `<pre>` draws it: pictographs take two cells. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if (/[\u{FE0F}\u{200D}]/u.test(char)) continue;
    width += /\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
  }
  return width;
}

export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

export function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
}

export function clip(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = '';
  for (const char of text) {
    if (displayWidth(out + char) >= width) break;
    out += char;
  }
  return `${out}…`;
}

export function commas(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function scaled(value: number, units: [number, string][], digits = 1): string {
  const abs = Math.abs(value);
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const number = value / size;
      const fixed = Math.abs(number) >= 100 ? number.toFixed(0) : number.toFixed(digits);
      return `${fixed.replace(/\.0+$/, '')}${suffix}`;
    }
  }
  return String(Math.round(value));
}

/** 1234 -> 1.2k, 8056779313 -> 8.1B */
export function compact(value: number): string {
  return scaled(value, [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ]);
}

export function signed(value: number): string {
  return `${value >= 0 ? '+' : '-'}${compact(Math.abs(value))}`;
}

export function money(value: number): string {
  if (value < 1) return `$${value.toFixed(2)}`;
  return `$${scaled(value, [
    [1e6, 'M'],
    [1e3, 'k'],
  ])}`;
}

export function bytes(value: number): string {
  const units: [number, string][] = [
    [1e9, 'GB'],
    [1e6, 'MB'],
    [1e3, 'kB'],
  ];
  for (const [size, unit] of units) {
    if (value >= size) return `${(value / size).toFixed(2)} ${unit}`;
  }
  return `${Math.round(value)} B`;
}

export function percent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** 0.4 -> 24m, 5 -> 5h, 49 -> 2d */
export function hours(value: number | null): string {
  if (value === null) return 'n/a';
  if (value < 1) return `${Math.max(1, Math.round(value * 60))}m`;
  if (value < 48) return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)}h`;
  return `${Math.round(value / 24)}d`;
}

/** Horizontal meter with eighth-block precision, always exactly `width` cells. */
export function bar(fraction: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const eighths = Math.round(clamped * width * 8);
  const full = Math.floor(eighths / 8);
  const partial = PARTIALS[eighths % 8];
  const used = full + (partial ? 1 : 0);
  return '█'.repeat(full) + partial + '░'.repeat(width - used);
}

/** Non-zero values always rise above the floor so faint activity stays visible. */
export function sparkline(values: number[]): string {
  const max = Math.max(0, ...values);
  if (max === 0) return SPARKS[0].repeat(values.length);
  return values
    .map((value) => {
      if (value <= 0) return SPARKS[0];
      const index = Math.ceil((value / max) * (SPARKS.length - 1));
      return SPARKS[Math.max(1, index)];
    })
    .join('');
}

export function table(rows: string[][], align: ('l' | 'r')[]): string[] {
  const widths = align.map((_, column) =>
    Math.max(...rows.map((row) => displayWidth(row[column] ?? ''))),
  );
  return rows.map((row) =>
    row
      .map((cell, column) =>
        align[column] === 'r' ? padStart(cell, widths[column]) : padEnd(cell, widths[column]),
      )
      .join('  ')
      .trimEnd(),
  );
}
