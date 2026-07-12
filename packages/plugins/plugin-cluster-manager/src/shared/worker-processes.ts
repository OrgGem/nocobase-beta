export type WorkerProcessKind = 'event-queue' | 'redis-list' | 'pubsub';

export type WorkerProcessDefinition = {
  name: string;
  label: string;
  description: string;
  kind: WorkerProcessKind;
  aliases?: string[];
  redisKeySuffixes?: string[];
  pluginName?: string;
  sandbox?: boolean;
  common?: boolean;
};

export const WORKER_PROCESS_DEFINITIONS: WorkerProcessDefinition[] = [
  {
    name: 'workflow:process',
    label: 'Workflow',
    description: 'Process workflow executions',
    kind: 'event-queue',
    aliases: ['workflow.pendingExecution', '@nocobase/plugin-workflow.pendingExecution'],
    common: true,
  },
  {
    name: 'async-task:process',
    label: 'Async Tasks',
    description: 'Execute async tasks',
    kind: 'event-queue',
    aliases: ['async-task-manager.task', '@nocobase/plugin-async-task-manager.task'],
    common: true,
  },
  {
    name: 'notification:send',
    label: 'Notifications',
    description: 'Send notification messages',
    kind: 'event-queue',
    aliases: ['notification-manager.send', '@nocobase/plugin-notification-manager.send'],
    common: true,
  },
  {
    name: 'knowledge-base:document-vectorize',
    label: 'Document Vectorization',
    description: 'Vectorize knowledge base documents',
    kind: 'event-queue',
    aliases: ['knowledge-base:document-vectorize'],
    pluginName: 'plugin-knowledge-base',
    common: true,
  },
  {
    name: 'git-review:process',
    label: 'Git Review',
    description: 'AI code review jobs',
    kind: 'redis-list',
    aliases: ['plugin-git-manager.review'],
    redisKeySuffixes: [':plugin-git-manager:review:queue'],
    pluginName: 'plugin-git-manager',
    common: true,
  },
  {
    name: 'build-guide:process',
    label: 'Build Guide',
    description: 'Build user guide pages',
    kind: 'redis-list',
    aliases: ['plugin-build-guide-block.build'],
    redisKeySuffixes: [':plugin-build-guide-block:build:queue'],
    pluginName: 'plugin-build-guide-block',
    common: true,
  },
  {
    name: 'build-visualization:process',
    label: 'Build Visualization',
    description: 'Build visualization blocks',
    kind: 'redis-list',
    aliases: ['plugin-build-visualization-block.build'],
    redisKeySuffixes: [':plugin-build-visualization-block:build:queue'],
    pluginName: 'plugin-build-visualization-block',
    common: true,
  },
  {
    name: 'build-ui-template:process',
    label: 'Build UI Template',
    description: 'Build UI template pages',
    kind: 'event-queue',
    aliases: ['plugin-build-ui-template.build'],
    pluginName: 'plugin-build-ui-template',
    common: true,
  },
  {
    name: 'file-preview-auth:ocr',
    label: 'File Preview OCR',
    description: 'Run OCR extraction for authenticated file previews',
    kind: 'redis-list',
    aliases: ['file-preview-auth.ocr.queue'],
    redisKeySuffixes: ['file-preview-auth.ocr.queue'],
    pluginName: 'plugin-file-preview-auth',
    common: true,
  },
  {
    name: 'file-search:index',
    label: 'File Search Indexing',
    description: 'Index accessible files for PageIndex-powered search',
    kind: 'event-queue',
    aliases: ['plugin-file-search.index'],
    pluginName: 'plugin-file-search',
    common: true,
  },
  {
    name: 'skill-hub:sandbox',
    label: 'Skill Sandbox',
    description: 'Execute Skill Hub sandbox tasks',
    kind: 'pubsub',
    aliases: ['skill-hub.task'],
    pluginName: 'plugin-agent-orchestrator',
    sandbox: true,
  },
];

const PROCESS_BY_NAME = new Map(WORKER_PROCESS_DEFINITIONS.map((definition) => [definition.name, definition]));

const ALIAS_TO_PROCESS = new Map<string, string>();
for (const definition of WORKER_PROCESS_DEFINITIONS) {
  ALIAS_TO_PROCESS.set(definition.name, definition.name);
  for (const alias of definition.aliases || []) {
    ALIAS_TO_PROCESS.set(alias, definition.name);
  }
}

function splitWorkerModeTokens(value?: string | string[]): string[] {
  const rawTokens = Array.isArray(value) ? value : String(value || '').split(',');
  return rawTokens.map((token) => String(token).trim()).filter(Boolean);
}

function stripKnownPrefixes(token: string): string[] {
  const candidates = [token];

  const dotIndex = token.indexOf('.');
  if (dotIndex > 0) {
    candidates.push(token.slice(dotIndex + 1));
  }

  const colonIndex = token.indexOf(':');
  if (colonIndex > 0) {
    candidates.push(token.slice(colonIndex + 1));
  }

  return Array.from(new Set(candidates));
}

export function resolveWorkerProcessName(token: string): string {
  const value = String(token || '').trim();
  if (!value || value === '*' || value === '!' || value === '-') {
    return value;
  }

  const directProcessName = ALIAS_TO_PROCESS.get(value);
  if (directProcessName) {
    return directProcessName;
  }

  for (const candidate of stripKnownPrefixes(value)) {
    const processName = ALIAS_TO_PROCESS.get(candidate);
    if (processName) {
      return processName;
    }
  }

  for (const definition of WORKER_PROCESS_DEFINITIONS) {
    if ((definition.redisKeySuffixes || []).some((suffix) => value.endsWith(suffix))) {
      return definition.name;
    }
  }

  return value;
}

export function normalizeWorkerMode(value?: string | string[]): string | undefined {
  const resolved = splitWorkerModeTokens(value).map(resolveWorkerProcessName);
  if (resolved.includes('*')) {
    return '*';
  }

  const unique = Array.from(new Set(resolved.filter(Boolean)));
  return unique.length ? unique.join(',') : undefined;
}

export function workerModeTokens(value?: string | string[]): string[] {
  const normalized = normalizeWorkerMode(value);
  return normalized ? normalized.split(',') : [];
}

export function workerModeServesProcess(workerMode: string | undefined, processNameOrAlias: string): boolean {
  const mode = normalizeWorkerMode(workerMode);
  if (!mode) return true;
  if (mode === 'main' || mode === 'app') return true;
  if (mode === '-') return false;
  if (mode === '*') return true;

  const processName = resolveWorkerProcessName(processNameOrAlias);
  return mode.split(',').includes(processName);
}

export function isWorkerOnlyMode(workerMode?: string): boolean {
  const mode = normalizeWorkerMode(workerMode);
  if (!mode || mode === 'main' || mode === 'app' || mode === '-') return false;
  return !mode.split(',').includes('!');
}

export function isAppServingMode(workerMode?: string): boolean {
  const mode = normalizeWorkerMode(workerMode);
  if (!mode || mode === 'main' || mode === 'app') return true;
  return mode.split(',').includes('!');
}

export function getWorkerProcessDefinition(nameOrAlias: string): WorkerProcessDefinition | undefined {
  return PROCESS_BY_NAME.get(resolveWorkerProcessName(nameOrAlias));
}

export function getCommonWorkerProcesses(): WorkerProcessDefinition[] {
  return WORKER_PROCESS_DEFINITIONS.filter((definition) => definition.common && !definition.sandbox);
}

export function getWorkerProcessByChannel(channel: string): WorkerProcessDefinition | undefined {
  const processName = resolveWorkerProcessName(channel);
  return PROCESS_BY_NAME.get(processName);
}
