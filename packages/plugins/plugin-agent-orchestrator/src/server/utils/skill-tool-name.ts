type RecordLike = Record<string, unknown> & {
  get?: (name: string) => unknown;
};

export type SkillToolScope = 'CUSTOM' | 'GENERAL' | 'SPECIFIED';

export function readRecordValue(record: unknown, key: string): unknown {
  const value = record as RecordLike | null | undefined;
  return typeof value?.get === 'function' ? value.get(key) : value?.[key];
}

/**
 * Preserve the legacy Skill Hub tool-name algorithm so existing AI employee
 * bindings continue to resolve after toolName becomes a persisted identity.
 */
export function buildSkillToolName(skillName: string): string {
  const normalized = String(skillName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  if (!normalized) {
    throw new Error('Skill name must contain at least one ASCII letter or number.');
  }

  return `skill_hub_${normalized}`;
}

export function getSkillToolName(skill: unknown): string {
  const persisted = readRecordValue(skill, 'toolName');
  if (typeof persisted === 'string' && persisted.trim()) {
    return persisted.trim();
  }

  return buildSkillToolName(String(readRecordValue(skill, 'name') || ''));
}

export function normalizeSkillToolScope(value: unknown): SkillToolScope {
  return value === 'GENERAL' || value === 'SPECIFIED' || value === 'CUSTOM' ? value : 'CUSTOM';
}

export async function assertSkillToolNameAvailable(
  db: { getRepository: (name: string) => { findOne: (options: Record<string, unknown>) => Promise<unknown> } },
  toolName: string,
  excludeId?: string | number,
): Promise<void> {
  const existing = await db.getRepository('skillDefinitions').findOne({
    filter: { toolName },
  });
  if (!existing) return;

  const existingId = readRecordValue(existing, 'id');
  if (excludeId != null && String(existingId) === String(excludeId)) return;

  throw new Error(`Skill tool name "${toolName}" is already registered.`);
}
