export function success(message: string): void {
  console.log(`✓ ${message}`);
}

export function fail(message: string): void {
  console.log(`✗ ${message}`);
}

export function warn(message: string): void {
  console.log(`! ${message}`);
}

export function info(message: string): void {
  console.log(message);
}

export function printTable(rows: string[][], headers: string[]): void {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );

  const formatRow = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");

  console.log(formatRow(headers));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}
