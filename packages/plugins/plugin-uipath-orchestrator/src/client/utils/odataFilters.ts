export type DateRangeValue = [unknown, unknown] | null;

export function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

export function odataString(value: string): string {
  return `'${escapeODataString(value)}'`;
}

export function combineFilters(
  filters: Array<string | undefined | null | false>,
  operator = 'and',
): string | undefined {
  const compact = filters.filter(Boolean) as string[];
  return compact.length ? compact.map((filter) => `(${filter})`).join(` ${operator} `) : undefined;
}

export function containsFilter(field: string, value?: string): string | undefined {
  const text = value?.trim();
  return text ? `contains(${field}, ${odataString(text)})` : undefined;
}

export function equalsFilter(field: string, value?: string | number | boolean | null): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return `${field} eq ${typeof value === 'string' ? odataString(value) : String(value)}`;
}

export function dateToOData(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  const candidate = value as { toDate?: () => Date; toISOString?: () => string };
  if (candidate.toDate) return candidate.toDate().toISOString();
  if (candidate.toISOString) return candidate.toISOString();
  return undefined;
}

export function dateRangeFilter(field: string, range?: DateRangeValue): string | undefined {
  if (!range) return undefined;
  const [from, to] = range;
  return combineFilters([
    dateToOData(from) ? `${field} ge ${dateToOData(from)}` : undefined,
    dateToOData(to) ? `${field} le ${dateToOData(to)}` : undefined,
  ]);
}

export function textAnyFilter(fields: string[], value?: string): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return combineFilters(
    fields.map((field) => containsFilter(field, text)),
    'or',
  );
}
