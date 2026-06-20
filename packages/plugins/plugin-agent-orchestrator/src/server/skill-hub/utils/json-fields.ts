export function parseJsonText<T = any>(value: any, fallback: T): T {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const json = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

export function stringifyJsonText(value: any, fallback: any = null): string {
  const normalized = value === undefined || value === null || value === '' ? fallback : value;
  if (typeof normalized === 'string') {
    const parsed = parseJsonText(normalized, undefined);
    if (parsed === undefined) return normalized;
    return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
  }
  return `\`\`\`json\n${JSON.stringify(normalized, null, 2)}\n\`\`\``;
}

export function parseJsonLike(value: any, fallback: any) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;

  const parsed = parseJsonText(value, undefined);
  if (parsed !== undefined) return parsed;

  return value.includes(',')
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : fallback;
}

export function parseSkillMarkdown(markdown: string) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { metadata: {}, body: markdown.trim() };

  const result: Record<string, any> = {};
  match[1].split(/\r?\n/).forEach((line) => {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.substring(0, idx).trim();
      const value = line.substring(idx + 1).trim();
      if (key) result[key] = value;
    }
  });

  const body = markdown.substring(match[0].length).trim();
  return { metadata: result, body };
}
