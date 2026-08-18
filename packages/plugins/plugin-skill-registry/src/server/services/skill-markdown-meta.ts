const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

export interface SkillMarkdownDocument {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseSkillMarkdownFrontmatter(markdown: string): Record<string, unknown> {
  const match = markdown.match(FRONTMATTER_PATTERN);
  if (!match) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const parsed = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!parsed) {
      continue;
    }
    const raw = parsed[2].trim().replace(/^['"]|['"]$/g, '');
    if (raw === 'true' || raw === 'false') {
      result[parsed[1]] = raw === 'true';
    } else {
      try {
        result[parsed[1]] = JSON.parse(raw);
      } catch {
        result[parsed[1]] = raw;
      }
    }
  }
  return result;
}

export function splitSkillMarkdown(markdown: string): SkillMarkdownDocument {
  const match = markdown.match(FRONTMATTER_PATTERN);
  if (!match) {
    return { frontmatter: {}, body: markdown };
  }
  return {
    frontmatter: parseSkillMarkdownFrontmatter(markdown),
    body: markdown.slice(match[0].length),
  };
}

export function frontmatterString(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
