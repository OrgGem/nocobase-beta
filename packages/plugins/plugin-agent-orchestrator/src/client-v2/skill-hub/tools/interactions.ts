import type { APIClient } from '@nocobase/client-v2';
import { parseJsonText } from '../utils/jsonFields';

type Field = { type?: string; title?: string; required?: boolean; enum?: Array<string | number | boolean> };
export type InteractionSchema = {
  type: 'form' | 'select' | 'confirm';
  prompt?: string;
  fields?: Record<string, Field>;
  options?: Array<{ label: string; value: string | number }>;
};
export type SkillDefinition = {
  id: string | number;
  name: string;
  toolName?: string;
  interactionSchema?: unknown;
};
export type LoopConfig = { skillId: string | number; schema?: unknown; prompt?: string };
export type SkillInteraction = { skillName: string; toolName: string; schema?: InteractionSchema };

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseInteraction(value: unknown): InteractionSchema | undefined {
  const record = asRecord(parseJsonText<unknown>(value, null));
  if (!['form', 'select', 'confirm'].includes(String(record.type))) return;
  const options = Array.isArray(record.options)
    ? record.options.flatMap((option) => {
        const row = asRecord(option);
        return typeof row.label === 'string' && (typeof row.value === 'string' || typeof row.value === 'number')
          ? [{ label: row.label, value: row.value }]
          : [];
      })
    : undefined;
  const fields = Object.fromEntries(
    Object.entries(asRecord(record.fields)).map(([key, value]) => {
      const field = asRecord(value);
      return [
        key,
        {
          type: typeof field.type === 'string' ? field.type : undefined,
          title: typeof field.title === 'string' ? field.title : undefined,
          required: field.required === true,
          enum: Array.isArray(field.enum)
            ? field.enum.filter((item): item is string | number | boolean =>
                ['string', 'number', 'boolean'].includes(typeof item),
              )
            : undefined,
        },
      ];
    }),
  );
  return {
    type: record.type as InteractionSchema['type'],
    prompt: typeof record.prompt === 'string' ? record.prompt : undefined,
    options,
    fields,
  };
}

export function buildInteractions(skills: SkillDefinition[], loops: LoopConfig[]): Map<string, SkillInteraction> {
  const bySkillId = new Map<string, LoopConfig>();
  // The API is sorted newest first, matching the server's loop-config selection.
  for (const loop of loops) if (!bySkillId.has(String(loop.skillId))) bySkillId.set(String(loop.skillId), loop);
  const interactions = new Map<string, SkillInteraction>();
  for (const skill of skills) {
    const normalized = skill.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    const toolName = skill.toolName?.trim() || (normalized ? `skill_hub_${normalized}` : undefined);
    if (!toolName) continue;
    const loop = bySkillId.get(String(skill.id));
    const loopSchema = parseInteraction(loop?.schema);
    const schema = loopSchema
      ? { ...loopSchema, prompt: loopSchema.prompt || loop?.prompt }
      : loop?.prompt
        ? { type: 'confirm' as const, prompt: loop.prompt }
        : parseInteraction(skill.interactionSchema);
    interactions.set(toolName, { skillName: skill.name, toolName, schema });
  }
  return interactions;
}

export async function loadInteractions(api: Pick<APIClient, 'request'>) {
  const [skills, loops] = await Promise.all([
    api.request<{ data: SkillDefinition[] }>({
      url: 'skillDefinitions:list',
      skipNotify: true,
      params: { filter: { enabled: true }, fields: ['id', 'name', 'toolName', 'interactionSchema'], paginate: false },
    }),
    api
      .request<{ data: LoopConfig[] }>({
        url: 'skillLoopConfigs:list',
        skipNotify: true,
        params: {
          filter: { enabled: true },
          fields: ['skillId', 'schema', 'prompt'],
          sort: ['-updatedAt'],
          paginate: false,
        },
      })
      .catch(() => ({ data: { data: [] } })),
  ]);
  return buildInteractions(skills.data.data, loops.data.data);
}

export function getToolInteraction(interactions: Map<string, SkillInteraction>, name: string, args: unknown) {
  const values = asRecord(args);
  if (name !== 'skill_hub_execute') return interactions.get(name)?.schema;
  if (values.action !== 'execute') return;
  return [...interactions.values()].find((item) => item.skillName === values.skillName)?.schema;
}

export function editedSkillArgs(
  name: string,
  args: unknown,
  schema: InteractionSchema,
  values: Record<string, unknown>,
) {
  const original = asRecord(args);
  if (name === 'skill_hub_execute') {
    return { ...original, input: schema.type === 'select' ? values : { ...asRecord(original.input), ...values } };
  }
  return schema.type === 'select' ? values : { ...original, ...values };
}
