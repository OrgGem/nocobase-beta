export function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

export function odataString(value: string): string {
  return `'${escapeODataString(value)}'`;
}

export function odataDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export function combineODataFilters(filters: Array<string | undefined | null | false>, operator = 'and'): string {
  return filters
    .filter(Boolean)
    .map((filter) => `(${filter})`)
    .join(` ${operator} `);
}

export function buildEqualsFilter(field: string, value?: string | number | boolean | null): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  return `${field} eq ${typeof value === 'string' ? odataString(value) : String(value)}`;
}

export function buildContainsFilter(field: string, value?: string | null): string | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }

  return `contains(${field}, ${odataString(text)})`;
}

export function buildDateRangeFilter(
  field: string,
  range?: { from?: string | Date | null; to?: string | Date | null } | null,
): string | undefined {
  if (!range?.from && !range?.to) {
    return undefined;
  }

  return combineODataFilters([
    range.from ? `${field} ge ${odataDate(range.from)}` : undefined,
    range.to ? `${field} le ${odataDate(range.to)}` : undefined,
  ]);
}

export function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}
