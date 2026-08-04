import { createHash } from 'crypto';

import type { Database } from '@nocobase/database';

type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };

export interface RegistrySkillSnapshotSummary {
  id: string;
}

export interface RegistrySkillSnapshot {
  id: string;
  name: string;
  title: string;
  description: string;
  language: 'python' | 'node';
  suggestedVersion?: string;
  inputSchema: JsonValue;
  instructions: string;
  files: Array<{ path: string; content: Buffer }>;
  portable: boolean;
  reason?: string;
  revision: string;
  dependencies: JsonValue;
}

type DefinitionModel = {
  get(attribute: string): unknown;
};

function positiveLimit(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

const MAX_REGISTRY_SKILL_SNAPSHOTS = positiveLimit(process.env.SKILL_REGISTRY_MAX_SOURCE_ITEMS, 1000, 10_000);
const MAX_REGISTRY_TEXT_BYTES = 10 * 1024 * 1024;

const registryExportFilter = {
  registryPackageId: null,
  registryVersionId: null,
  registryInstallationId: null,
  registryInstallStatus: null,
  registryExportEnabled: true,
};

export const REGISTRY_EXPORT_NOT_GRANTED = 'REGISTRY_EXPORT_NOT_GRANTED';
export const REGISTRY_EXPORT_LIMIT_EXCEEDED = 'REGISTRY_EXPORT_LIMIT_EXCEEDED';

export class RegistryExportNotGrantedError extends Error {
  readonly code = REGISTRY_EXPORT_NOT_GRANTED;

  constructor() {
    super('Registry export is not enabled for this Skill Hub definition.');
    this.name = 'RegistryExportNotGrantedError';
  }
}

export class RegistryExportLimitError extends Error {
  readonly code = REGISTRY_EXPORT_LIMIT_EXCEEDED;

  constructor(message: string) {
    super(message);
    this.name = 'RegistryExportLimitError';
  }
}

function value(model: DefinitionModel, attribute: string): unknown {
  return model.get(attribute);
}

function text(model: DefinitionModel, attribute: string, fallback = ''): string {
  const raw = value(model, attribute);
  return typeof raw === 'string' ? raw : raw === null || raw === undefined ? fallback : String(raw);
}

function parseJson(raw: unknown, fallback: JsonValue): JsonValue {
  if (raw === null || typeof raw === 'string' || typeof raw === 'boolean') {
    if (typeof raw !== 'string') {
      return raw;
    }
    try {
      return JSON.parse(raw) as JsonValue;
    } catch {
      return fallback;
    }
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (Array.isArray(raw) || (typeof raw === 'object' && raw !== null)) {
    return raw as JsonValue;
  }
  return fallback;
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function digest(value: JsonValue): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function asPortableSnapshot(model: DefinitionModel): RegistrySkillSnapshot {
  const id = text(model, 'id');
  const name = text(model, 'name');
  const storageType = text(model, 'storageType', 'database');
  const codeTemplate = text(model, 'codeTemplate');
  const language = text(model, 'language', 'python') === 'node' ? 'node' : 'python';
  const inputSchema = parseJson(value(model, 'inputSchema'), { type: 'object', properties: {} });
  const dependencies = parseJson(value(model, 'packages'), []);
  const instructions = text(model, 'instructions');
  if (
    Buffer.byteLength(codeTemplate, 'utf8') > MAX_REGISTRY_TEXT_BYTES ||
    Buffer.byteLength(instructions, 'utf8') > MAX_REGISTRY_TEXT_BYTES
  ) {
    throw new RegistryExportLimitError('Skill Hub definition exceeds the registry source-file limit.');
  }
  const revisionInput = {
    id,
    name,
    storageType,
    codeTemplate,
    language,
    inputSchema,
    dependencies,
    instructions,
    title: text(model, 'title'),
    description: text(model, 'description'),
  };
  if (storageType === 'plugin') {
    return {
      id,
      name,
      title: text(model, 'title', name),
      description: text(model, 'description'),
      language,
      inputSchema,
      instructions,
      files: [],
      portable: false,
      reason: 'Plugin-backed skills require an explicit portable export bundle.',
      revision: digest(revisionInput),
      dependencies,
    };
  }
  if (!codeTemplate.trim()) {
    return {
      id,
      name,
      title: text(model, 'title', name),
      description: text(model, 'description'),
      language,
      inputSchema,
      instructions,
      files: [],
      portable: false,
      reason: 'Skill has no inline code bundle to export.',
      revision: digest(revisionInput),
      dependencies,
    };
  }
  const entrypoint = language === 'node' ? 'src/index.js' : 'src/index.py';
  const skillMarkdown = [
    '---',
    `name: ${name}`,
    `title: ${text(model, 'title', name)}`,
    `description: ${text(model, 'description').replace(/\r?\n/g, ' ')}`,
    `language: ${language}`,
    '---',
    '',
    instructions,
  ].join('\n');
  return {
    id,
    name,
    title: text(model, 'title', name),
    description: text(model, 'description'),
    language,
    inputSchema,
    instructions,
    files: [
      { path: 'SKILL.md', content: Buffer.from(skillMarkdown, 'utf8') },
      { path: entrypoint, content: Buffer.from(codeTemplate, 'utf8') },
    ],
    portable: true,
    revision: digest(revisionInput),
    dependencies,
  };
}

export class RegistrySkillSnapshotService {
  constructor(private readonly database: Database) {}

  async listSkillSnapshots(): Promise<RegistrySkillSnapshotSummary[]> {
    // Registry-installed rows are local runtime projections of an immutable
    // registry package. Exporting them back through Skill Hub would let the
    // registry re-discover and publish its own installed artifacts.
    const definitions = await this.database.getRepository('skillDefinitions').find({
      fields: ['id'],
      filter: registryExportFilter,
      sort: ['id'],
      limit: MAX_REGISTRY_SKILL_SNAPSHOTS + 1,
    });
    if (definitions.length > MAX_REGISTRY_SKILL_SNAPSHOTS) {
      throw new RegistryExportLimitError('Skill Hub registry export exceeds the configured source-item limit.');
    }
    return definitions.map((definition) => ({ id: String(definition.get('id')) }));
  }

  async getSkillSnapshot(skillDefinitionId: string): Promise<RegistrySkillSnapshot> {
    const definition = await this.database.getRepository('skillDefinitions').findOne({
      filter: {
        id: skillDefinitionId,
        ...registryExportFilter,
      },
    });
    if (!definition) {
      // Use one result for missing and ungranted definitions so the internal
      // service cannot be used to enumerate private Skill Hub content.
      throw new RegistryExportNotGrantedError();
    }
    return asPortableSnapshot(definition as unknown as DefinitionModel);
  }
}
