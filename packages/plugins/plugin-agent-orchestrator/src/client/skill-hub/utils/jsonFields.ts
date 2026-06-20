export function parseJsonText<T = any>(value: any, fallback: T): T {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const json = fenced ? fenced[1].trim() : trimmed;

  try {
    let parsed = JSON.parse(json);
    if (typeof parsed === 'string') {
      const innerTrimmed = parsed.trim();
      const innerFenced = innerTrimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      const innerJson = innerFenced ? innerFenced[1].trim() : innerTrimmed;
      try {
        parsed = JSON.parse(innerJson);
      } catch {
        // Keep the original parsed string when nested JSON parsing fails.
      }
    }
    return parsed;
  } catch {
    return fallback;
  }
}

export function formatJsonText(value: any, fallback: any = null): string {
  const parsed = parseJsonText(value, undefined);
  const normalized =
    parsed === undefined ? (value === undefined || value === null || value === '' ? fallback : value) : parsed;
  if (normalized === undefined || normalized === null) return '';
  if (typeof normalized === 'string') return normalized;
  return JSON.stringify(normalized, null, 2);
}

export function stringifyJsonText(value: any, fallback: any = null): string {
  const parsed = parseJsonText(value, undefined);
  const normalized =
    parsed === undefined ? (value === undefined || value === null || value === '' ? fallback : value) : parsed;
  return `\`\`\`json\n${JSON.stringify(normalized, null, 2)}\n\`\`\``;
}
