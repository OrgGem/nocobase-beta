import { Context } from '@nocobase/actions';
import Application from '@nocobase/server';
import crypto from 'crypto';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { RedisNodeRegistry } from '../adapters/redis-node-registry';
import type { ContainerInfo, StackConfig } from '../orchestrator/types';
import { getLocalNodeId, getNodeRoleFrom } from '../utils/node';
import { getRedisClient, scanKeys } from '../utils/redis';
import { packagesFromConfig, type CustomPackageMap, type WorkerPackageMap } from '../../shared/packages';

const ACTIVE_RUN_KEY = 'cluster-manager:doctor:active';
const RESPONSE_KEY_PREFIX = 'cluster-manager:doctor-response:';
const FINISH_LOCK_PREFIX = 'cluster-manager:doctor:finish-lock:';
const DEFAULT_DURATION_MS = 120000;
const MAX_DURATION_MS = 120000;
const MIN_DURATION_MS = 10000;
const LOCK_BUFFER_MS = 30000;
const SNAPSHOT_RESPONSE_TTL_SECONDS = 90;
const FINISH_LOCK_TTL_SECONDS = 90;
const MAX_NODE_LOG_LINES = 800;
const MAX_CONTAINER_LOG_LINES = 200;
const LOG_PREFIXES = ['system', 'system_error', 'request'];

interface RepositoryLike {
  findOne(options?: Record<string, unknown>): Promise<ModelLike | null>;
  find(options?: Record<string, unknown>): Promise<ModelLike[]>;
  create(options: Record<string, unknown>): Promise<ModelLike>;
  update(options: Record<string, unknown>): Promise<unknown>;
  count?(options?: Record<string, unknown>): Promise<number>;
}

interface ModelLike {
  get(name: string): unknown;
  toJSON?(): Record<string, unknown>;
}

interface RedisLike {
  sendCommand(command: string[]): Promise<unknown>;
  ping?(): Promise<unknown>;
  info?(): Promise<string>;
}

interface PubSubLike {
  publish(channel: string, payload: unknown): Promise<unknown> | unknown;
  isConnected?(): Promise<boolean> | boolean;
}

interface AppRuntime {
  name?: string;
  db: {
    getRepository(name: string): RepositoryLike;
    hasCollection?(name: string): boolean;
    sequelize?: {
      query(sql: string): Promise<unknown>;
    };
  };
  pm?: {
    get(name: string): unknown;
  };
  pubSubManager?: PubSubLike;
  eventQueue?: unknown;
  logger: {
    info(message: string, meta?: Record<string, unknown>): unknown;
    warn(message: string, meta?: Record<string, unknown>): unknown;
    error(message: string, meta?: Record<string, unknown>): unknown;
    debug?(message: string, meta?: Record<string, unknown>): unknown;
  };
}

interface DoctorActiveState {
  runId: string;
  startedAt: string;
  deadlineAt: string;
  durationMs: number;
  startedBy?: string;
}

interface DoctorNodeRecord {
  id?: string;
  name?: string;
  hostname?: string;
  appVersion?: string;
  workerMode?: string;
  appRole?: string;
  isSandbox?: boolean;
  status?: string;
  lastHeartbeatAt?: number;
  pid?: number;
}

interface DiagnosticLogLine {
  source: string;
  line: string;
  timestamp?: string;
  level?: string;
  message?: string;
  stack?: string;
}

interface LogSignature {
  signature: string;
  level: string;
  count: number;
  firstSeen?: string;
  lastSeen?: string;
  sources: string[];
  samples: string[];
}

interface LogAnalysis {
  totalLines: number;
  levels: Record<string, number>;
  signatures: LogSignature[];
}

interface PluginSnapshot {
  name?: string;
  packageName?: string;
  enabled?: boolean;
  dbVersion?: string;
  loaded: boolean;
  runtimeVersion?: string;
}

interface DoctorNodeSnapshot {
  nodeId: string;
  node: {
    hostname: string;
    pid: number;
    workerMode: string;
    role: string;
    appVersion: string;
    nodeVersion: string;
    platform: string;
    arch: string;
    uptime: number;
    isSandbox: boolean;
  };
  memory: NodeJS.MemoryUsage;
  os: {
    totalMemory: number;
    freeMemory: number;
    cpuCount: number;
    loadAvg: number[];
  };
  env: Record<string, string | undefined>;
  plugins: PluginSnapshot[];
  logs: {
    files: Array<{ file: string; lineCount: number }>;
    lines: DiagnosticLogLine[];
    analysis: LogAnalysis;
  };
  collectedAt: string;
  error?: string;
}

interface DoctorSnapshotOptions {
  runId?: string;
  sinceMs?: number;
  untilMs?: number;
  maxLines?: number;
}

interface NormalizedPackages {
  apt: string[];
  npm: string[];
  python: string[];
}

class ActiveDoctorRunError extends Error {
  constructor(public activeRun: DoctorActiveState | null) {
    super('A diagnostic session is already running.');
  }
}

const timers = new Map<string, NodeJS.Timeout>();
let localActiveRun: DoctorActiveState | null = null;

function getApp(app: Application): AppRuntime {
  return app as unknown as AppRuntime;
}

function getPayload(ctx: Context) {
  return (ctx.action.params.values ||
    (ctx as unknown as { request?: { body?: unknown } }).request?.body ||
    {}) as Record<string, unknown>;
}

function clampDuration(value: unknown) {
  const duration = Number(value) || DEFAULT_DURATION_MS;
  return Math.min(Math.max(duration, MIN_DURATION_MS), MAX_DURATION_MS);
}

function modelToJSON(model: ModelLike | null | undefined): Record<string, unknown> | null {
  if (!model) return null;
  if (typeof model.toJSON === 'function') {
    return model.toJSON();
  }
  return {};
}

function getModelValue(model: ModelLike | Record<string, unknown>, key: string): unknown {
  if ('get' in model && typeof model.get === 'function') {
    return model.get(key);
  }
  return model[key];
}

function getRepository(app: Application, name: string): RepositoryLike {
  return getApp(app).db.getRepository(name);
}

function getUserLabel(ctx: Context) {
  const state = (ctx as unknown as { state?: { currentUser?: Record<string, unknown> } }).state;
  const currentUser = state?.currentUser;
  return String(currentUser?.nickname || currentUser?.username || currentUser?.id || 'unknown');
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (!value) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function normalizePackageMap(packages?: WorkerPackageMap): NormalizedPackages {
  return {
    apt: normalizeList(packages?.apt),
    npm: normalizeList(packages?.npm),
    python: normalizeList(packages?.python),
  };
}

function parseCustomPackages(value: unknown): CustomPackageMap {
  const custom = parseJson<CustomPackageMap>(value, { python: [], node: [], npm: [] });
  return {
    python: normalizeList(custom.python),
    node: normalizeList(custom.node),
    npm: normalizeList(custom.npm),
  };
}

function parsePackageWhitelist(value: unknown): NormalizedPackages {
  const whitelist = parseJson<{ apt?: string[]; npm?: string[]; node?: string[]; python?: string[] }>(value, {});
  return {
    apt: normalizeList(whitelist.apt),
    npm: normalizeList([...(whitelist.npm || []), ...(whitelist.node || [])]),
    python: normalizeList(whitelist.python),
  };
}

function diffPackages(expected: NormalizedPackages, installed: NormalizedPackages): NormalizedPackages {
  return {
    apt: expected.apt.filter((pkg) => !installed.apt.includes(pkg)),
    npm: expected.npm.filter((pkg) => !installed.npm.includes(pkg)),
    python: expected.python.filter((pkg) => !installed.python.includes(pkg)),
  };
}

function countPackages(packages: NormalizedPackages) {
  return packages.apt.length + packages.npm.length + packages.python.length;
}

function getNodeRole(node: {
  workerMode?: string;
  appRole?: string;
  isSandbox?: boolean;
}): 'app' | 'worker' | 'sandbox' {
  return getNodeRoleFrom({ workerMode: node.workerMode, appRole: node.appRole, isSandbox: node.isSandbox });
}

function getSafeEnv() {
  return {
    APP_ENV: process.env.APP_ENV,
    APP_NAME: process.env.APP_NAME,
    APP_ROLE: process.env.APP_ROLE,
    APP_PORT: process.env.APP_PORT,
    CLUSTER_MODE: process.env.CLUSTER_MODE,
    WORKER_MODE: process.env.WORKER_MODE,
    LOGGER_LEVEL: process.env.LOGGER_LEVEL,
    LOGGER_FORMAT: process.env.LOGGER_FORMAT,
    LOGGER_TRANSPORT: process.env.LOGGER_TRANSPORT,
    NOCOBASE_VERSION: process.env.NOCOBASE_VERSION,
    DB_DIALECT: process.env.DB_DIALECT,
  };
}

function redactText(value: string) {
  return value
    .replace(
      /(authorization|cookie|set-cookie|token|secret|password|passwd|pwd|api[-_]?key)=([^,\s&]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/:\/\/([^:/\s]+):([^@/\s]+)@/g, '://[REDACTED]:[REDACTED]@');
}

function getLogDir(app: Application) {
  const appLike = getApp(app);
  const logBasePath = process.env.LOGGER_BASE_PATH || path.resolve(process.cwd(), 'storage', 'logs');
  const appName = process.env.APP_NAME || appLike.name || 'main';
  return path.resolve(logBasePath, appName);
}

async function readTailLines(filePath: string, maxLines: number) {
  try {
    const stat = await fsp.stat(filePath);
    const bufferSize = Math.min(stat.size, Math.max(maxLines, 1) * 2048);
    const buffer = Buffer.alloc(bufferSize);
    const fh = await fsp.open(filePath, 'r');
    try {
      await fh.read(buffer, 0, bufferSize, Math.max(0, stat.size - bufferSize));
    } finally {
      await fh.close();
    }
    return buffer
      .toString('utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(-maxLines);
  } catch {
    return [];
  }
}

function parseLogTimestamp(line: string): number | null {
  try {
    const parsed = JSON.parse(line) as { timestamp?: string };
    if (parsed.timestamp) {
      const time = Date.parse(parsed.timestamp);
      return Number.isFinite(time) ? time : null;
    }
  } catch {
    // Fall through to text timestamp parsing.
  }

  const match = line.match(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (!match) return null;
  const value = match[1].includes('T') ? match[1] : match[1].replace(' ', 'T');
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function parseDiagnosticLine(source: string, rawLine: string): DiagnosticLogLine {
  const redacted = redactText(rawLine);
  try {
    const parsed = JSON.parse(redacted) as Record<string, unknown>;
    return {
      source,
      line: redacted,
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
      level: typeof parsed.level === 'string' ? parsed.level.toLowerCase() : undefined,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
      stack: typeof parsed.stack === 'string' ? parsed.stack : undefined,
    };
  } catch {
    const levelMatch = redacted.match(/\b(?:level=|\[)(error|warn|warning|info|debug|trace)\b/i);
    const timestamp = parseLogTimestamp(redacted);
    return {
      source,
      line: redacted,
      timestamp: timestamp ? new Date(timestamp).toISOString() : undefined,
      level: levelMatch?.[1]?.toLowerCase().replace('warning', 'warn'),
      message: redacted.replace(/^\d{4}-\d{2}-\d{2}[^[]*/, '').trim(),
    };
  }
}

function normalizeSignature(value: string) {
  return value
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\b\d+\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function analyzeLogLines(lines: DiagnosticLogLine[]): LogAnalysis {
  const levels: Record<string, number> = {};
  const signatures = new Map<string, LogSignature>();

  for (const item of lines) {
    const level = item.level || (/error/i.test(item.line) ? 'error' : /warn/i.test(item.line) ? 'warn' : 'info');
    levels[level] = (levels[level] || 0) + 1;

    if (level !== 'error' && level !== 'warn') {
      continue;
    }

    const base = item.stack || item.message || item.line;
    const signature = normalizeSignature(base);
    const key = `${level}:${signature}`;
    const existing = signatures.get(key);
    if (existing) {
      existing.count++;
      existing.lastSeen = item.timestamp || existing.lastSeen;
      if (!existing.sources.includes(item.source)) {
        existing.sources.push(item.source);
      }
      if (existing.samples.length < 3) {
        existing.samples.push(item.line.slice(0, 1000));
      }
    } else {
      signatures.set(key, {
        signature,
        level,
        count: 1,
        firstSeen: item.timestamp,
        lastSeen: item.timestamp,
        sources: [item.source],
        samples: [item.line.slice(0, 1000)],
      });
    }
  }

  return {
    totalLines: lines.length,
    levels,
    signatures: [...signatures.values()].sort((a, b) => b.count - a.count).slice(0, 50),
  };
}

async function readDiagnosticLogs(app: Application, options: DoctorSnapshotOptions) {
  const logDir = getLogDir(app);
  const maxLines = Math.min(Number(options.maxLines) || MAX_NODE_LOG_LINES, MAX_NODE_LOG_LINES);
  const sinceMs = Number(options.sinceMs) || 0;
  const untilMs = Number(options.untilMs) || Date.now();
  const files: Array<{ file: string; lineCount: number }> = [];
  const lines: DiagnosticLogLine[] = [];

  let names: string[] = [];
  try {
    names = await fsp.readdir(logDir);
  } catch {
    return { files, lines, analysis: analyzeLogLines(lines) };
  }

  const candidates = names
    .filter((name) => name.endsWith('.log') && LOG_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .sort()
    .reverse()
    .slice(0, 12);

  const perFileLimit = Math.max(50, Math.ceil(maxLines / Math.max(candidates.length || 1, 1)));
  for (const file of candidates) {
    const filePath = path.resolve(logDir, file);
    const rawLines = await readTailLines(filePath, perFileLimit);
    const parsedLines = rawLines
      .map((line) => parseDiagnosticLine(file, line))
      .filter((line) => {
        const timestamp = line.timestamp ? Date.parse(line.timestamp) : parseLogTimestamp(line.line);
        if (!timestamp) return true;
        return timestamp >= sinceMs && timestamp <= untilMs;
      });

    if (parsedLines.length > 0) {
      files.push({ file, lineCount: parsedLines.length });
      lines.push(...parsedLines);
    }
  }

  const limitedLines = lines.slice(-maxLines);
  return {
    files,
    lines: limitedLines,
    analysis: analyzeLogLines(limitedLines),
  };
}

async function getApplicationPluginRows(app: Application) {
  try {
    const repo = getRepository(app, 'applicationPlugins');
    const rows = await repo.find({ sort: ['name'] });
    return rows.map((row) => modelToJSON(row) || {});
  } catch {
    return [];
  }
}

function getLoadedPlugin(app: Application, name?: unknown, packageName?: unknown) {
  const pm = getApp(app).pm;
  if (!pm?.get) return null;
  const pluginName = typeof name === 'string' ? name : '';
  const pluginPackageName = typeof packageName === 'string' ? packageName : '';
  return pm.get(pluginName) || pm.get(pluginPackageName) || null;
}

function getRuntimePluginVersion(instance: unknown) {
  const plugin = instance as {
    version?: string;
    options?: {
      packageJson?: {
        version?: string;
      };
    };
  } | null;
  return plugin?.options?.packageJson?.version || plugin?.version;
}

async function getLocalPluginSnapshot(app: Application): Promise<PluginSnapshot[]> {
  const rows = await getApplicationPluginRows(app);
  return rows.map((row) => {
    const instance = getLoadedPlugin(app, row.name, row.packageName);
    return {
      name: typeof row.name === 'string' ? row.name : undefined,
      packageName: typeof row.packageName === 'string' ? row.packageName : undefined,
      enabled: Boolean(row.enabled),
      dbVersion: typeof row.version === 'string' ? row.version : undefined,
      loaded: Boolean(instance),
      runtimeVersion: getRuntimePluginVersion(instance),
    };
  });
}

export async function collectLocalDoctorSnapshot(
  app: Application,
  options: DoctorSnapshotOptions = {},
): Promise<DoctorNodeSnapshot> {
  const workerMode = process.env.WORKER_MODE || 'main';
  const appRole = process.env.APP_ROLE;
  const node = {
    hostname: os.hostname(),
    pid: process.pid,
    workerMode,
    role: getNodeRole({ workerMode, appRole, isSandbox: process.env.SKILL_HUB_SANDBOX === 'true' }),
    appVersion: process.env.NOCOBASE_VERSION || process.version,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    uptime: process.uptime(),
    isSandbox: process.env.SKILL_HUB_SANDBOX === 'true',
  };

  return {
    nodeId: getLocalNodeId(app),
    node,
    memory: process.memoryUsage(),
    os: {
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      cpuCount: os.cpus().length,
      loadAvg: os.loadavg(),
    },
    env: getSafeEnv(),
    plugins: await getLocalPluginSnapshot(app),
    logs: await readDiagnosticLogs(app, options),
    collectedAt: new Date().toISOString(),
  };
}

async function getActiveRunState(app: Application): Promise<DoctorActiveState | null> {
  const redis = getRedisClient(app) as RedisLike | null;
  if (redis) {
    const raw = await redis.sendCommand(['GET', ACTIVE_RUN_KEY]);
    if (typeof raw !== 'string' || !raw) return null;
    return parseJson<DoctorActiveState | null>(raw, null);
  }

  if (!localActiveRun) return null;
  if (Date.parse(localActiveRun.deadlineAt) + LOCK_BUFFER_MS < Date.now()) {
    localActiveRun = null;
    return null;
  }
  return localActiveRun;
}

async function acquireActiveRun(app: Application, state: DoctorActiveState) {
  const redis = getRedisClient(app) as RedisLike | null;
  if (redis) {
    const ttlMs = state.durationMs + LOCK_BUFFER_MS;
    const result = await redis.sendCommand(['SET', ACTIVE_RUN_KEY, JSON.stringify(state), 'NX', 'PX', String(ttlMs)]);
    if (result !== 'OK') {
      throw new ActiveDoctorRunError(await getActiveRunState(app));
    }
    return;
  }

  const activeRun = await getActiveRunState(app);
  if (activeRun) {
    throw new ActiveDoctorRunError(activeRun);
  }
  localActiveRun = state;
}

async function releaseActiveRun(app: Application, runId: string) {
  const redis = getRedisClient(app) as RedisLike | null;
  if (redis) {
    const activeRun = await getActiveRunState(app);
    if (activeRun?.runId === runId) {
      await redis.sendCommand(['DEL', ACTIVE_RUN_KEY]);
    }
    return;
  }
  if (localActiveRun?.runId === runId) {
    localActiveRun = null;
  }
}

async function acquireFinishLock(app: Application, runId: string) {
  const redis = getRedisClient(app) as RedisLike | null;
  if (!redis) return true;
  const result = await redis.sendCommand([
    'SET',
    `${FINISH_LOCK_PREFIX}${runId}`,
    process.pid.toString(),
    'NX',
    'EX',
    String(FINISH_LOCK_TTL_SECONDS),
  ]);
  return result === 'OK';
}

async function releaseFinishLock(app: Application, runId: string) {
  const redis = getRedisClient(app) as RedisLike | null;
  if (!redis) return;
  await redis.sendCommand(['DEL', `${FINISH_LOCK_PREFIX}${runId}`]);
}

function clearRunTimer(runId: string) {
  const timer = timers.get(runId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(runId);
  }
}

function scheduleAutoFinish(app: Application, runId: string, deadlineAt: string) {
  clearRunTimer(runId);
  const delayMs = Math.max(0, Date.parse(deadlineAt) - Date.now());
  const timer = setTimeout(() => {
    finishDoctorRun(app, runId, 'timeout').catch((error) => {
      getApp(app).logger.error(
        `[ClusterDoctor] Failed to auto-finish diagnostic run ${runId}: ${getErrorMessage(error)}`,
      );
    });
  }, delayMs);
  timers.set(runId, timer);
}

async function getRunById(app: Application, runId: string) {
  const repo = getRepository(app, 'clusterManagerDoctorRuns');
  return repo.findOne({ filter: { runId } });
}

async function getLatestRun(app: Application) {
  const repo = getRepository(app, 'clusterManagerDoctorRuns');
  const rows = await repo.find({ sort: ['-createdAt'], limit: 1 });
  return rows[0] || null;
}

function runJsonToActiveState(run: Record<string, unknown>): DoctorActiveState | null {
  if (!run.runId || !run.startedAt || !run.deadlineAt) return null;
  return {
    runId: String(run.runId),
    startedAt: new Date(String(run.startedAt)).toISOString(),
    deadlineAt: new Date(String(run.deadlineAt)).toISOString(),
    durationMs: Number(run.durationMs || DEFAULT_DURATION_MS),
    startedBy: typeof run.startedBy === 'string' ? run.startedBy : undefined,
  };
}

async function getBlockingRunStateFromDb(app: Application) {
  const latestRun = modelToJSON(await getLatestRun(app));
  if (!latestRun || latestRun.status !== 'running') {
    return null;
  }

  const activeState = runJsonToActiveState(latestRun);
  if (!activeState) return null;
  if (Date.parse(activeState.deadlineAt) + LOCK_BUFFER_MS <= Date.now()) {
    return null;
  }
  return activeState;
}

async function updateRun(app: Application, runId: string, values: Record<string, unknown>) {
  const repo = getRepository(app, 'clusterManagerDoctorRuns');
  await repo.update({ filter: { runId }, values });
}

async function getClusterNodes(app: Application): Promise<DoctorNodeRecord[]> {
  const plugin = getApp(app).pm?.get('plugin-cluster-manager') as { nodeRegistry?: RedisNodeRegistry } | null;
  const registry = plugin?.nodeRegistry ?? new RedisNodeRegistry(app);
  return registry.getNodes();
}

async function requestRemoteSnapshot(
  app: Application,
  node: DoctorNodeRecord,
  options: DoctorSnapshotOptions,
): Promise<DoctorNodeSnapshot> {
  const targetNodeId = node.id;
  if (!targetNodeId) {
    throw new Error('Node does not have an id.');
  }

  if (targetNodeId === getLocalNodeId(app)) {
    return collectLocalDoctorSnapshot(app, options);
  }

  const redis = getRedisClient(app) as RedisLike | null;
  const pubSub = getApp(app).pubSubManager;
  if (!redis || !pubSub) {
    throw new Error('Redis/PubSub is not available for remote diagnostic snapshot collection.');
  }

  const requestId = crypto.randomBytes(8).toString('hex');
  const responseKey = `${RESPONSE_KEY_PREFIX}${requestId}`;
  await pubSub.publish(
    `cluster-manager:doctor-collect:${targetNodeId}`,
    JSON.stringify({
      requestId,
      targetNodeId,
      runId: options.runId,
      sinceMs: options.sinceMs,
      untilMs: options.untilMs,
      maxLines: options.maxLines,
    }),
  );

  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const raw = await redis.sendCommand(['GET', responseKey]);
    if (typeof raw === 'string' && raw) {
      await redis.sendCommand(['DEL', responseKey]);
      const snapshot = parseJson<Partial<DoctorNodeSnapshot>>(raw, {});
      if (snapshot.node && snapshot.logs) {
        return snapshot as DoctorNodeSnapshot;
      }
      throw new Error(snapshot.error || 'Invalid diagnostic snapshot response payload.');
    }
  }

  throw new Error(`Timeout waiting for diagnostic snapshot from ${targetNodeId}.`);
}

async function collectNodeSnapshots(
  app: Application,
  nodes: DoctorNodeRecord[],
  options: DoctorSnapshotOptions,
): Promise<DoctorNodeSnapshot[]> {
  const targets = nodes.length > 0 ? nodes : [{ id: getLocalNodeId(app), hostname: os.hostname() }];
  return Promise.all(
    targets.map(async (node) => {
      try {
        return await requestRemoteSnapshot(app, node, options);
      } catch (error) {
        const workerMode = node.workerMode || 'unknown';
        return {
          nodeId: node.id || `${node.hostname || 'unknown'}:${node.pid || 'unknown'}`,
          node: {
            hostname: node.hostname || 'unknown',
            pid: Number(node.pid || 0),
            workerMode,
            role: getNodeRole({ workerMode, appRole: node.appRole, isSandbox: node.isSandbox }),
            appVersion: node.appVersion || '',
            nodeVersion: '',
            platform: '',
            arch: '',
            uptime: 0,
            isSandbox: Boolean(node.isSandbox),
          },
          memory: process.memoryUsage(),
          os: { totalMemory: 0, freeMemory: 0, cpuCount: 0, loadAvg: [] },
          env: {},
          plugins: [],
          logs: { files: [], lines: [], analysis: analyzeLogLines([]) },
          collectedAt: new Date().toISOString(),
          error: getErrorMessage(error),
        };
      }
    }),
  );
}

function aggregateTopSignatures(snapshots: DoctorNodeSnapshot[], containerDiagnostics: Record<string, unknown>) {
  const signatures = new Map<string, LogSignature & { nodes: string[] }>();
  const collect = (nodeId: string, items: LogSignature[]) => {
    for (const item of items) {
      const key = `${item.level}:${item.signature}`;
      const existing = signatures.get(key);
      if (existing) {
        existing.count += item.count;
        if (!existing.nodes.includes(nodeId)) {
          existing.nodes.push(nodeId);
        }
        for (const source of item.sources) {
          if (!existing.sources.includes(source)) existing.sources.push(source);
        }
        existing.samples.push(...item.samples.slice(0, Math.max(0, 3 - existing.samples.length)));
      } else {
        signatures.set(key, { ...item, nodes: [nodeId], samples: item.samples.slice(0, 3) });
      }
    }
  };

  snapshots.forEach((snapshot) => collect(snapshot.nodeId, snapshot.logs.analysis.signatures));

  const containerStacks = Array.isArray(containerDiagnostics.stacks) ? containerDiagnostics.stacks : [];
  for (const stack of containerStacks as Array<{
    containers?: Array<{ id: string; logs?: { analysis?: LogAnalysis } }>;
  }>) {
    for (const container of stack.containers || []) {
      collect(`container:${container.id}`, container.logs?.analysis?.signatures || []);
    }
  }

  return [...signatures.values()].sort((a, b) => b.count - a.count).slice(0, 30);
}

function buildVersionDiagnostics(nodes: DoctorNodeRecord[], snapshots: DoctorNodeSnapshot[]) {
  const nodeVersions = snapshots.map((snapshot) => ({
    nodeId: snapshot.nodeId,
    hostname: snapshot.node.hostname,
    role: snapshot.node.role,
    appVersion: snapshot.node.appVersion,
    nodeVersion: snapshot.node.nodeVersion,
    platform: snapshot.node.platform,
    arch: snapshot.node.arch,
  }));
  const appVersions = new Set(nodeVersions.map((node) => node.appVersion).filter(Boolean));
  const runtimeVersions = new Set(
    nodeVersions.map((node) => `${node.nodeVersion}:${node.platform}:${node.arch}`).filter(Boolean),
  );

  return {
    registryNodes: nodes,
    nodeVersions,
    versionDrift: appVersions.size > 1,
    runtimeDrift: runtimeVersions.size > 1,
  };
}

function buildPluginDiagnostics(pluginRows: Record<string, unknown>[], snapshots: DoctorNodeSnapshot[]) {
  const plugins = pluginRows.map((plugin) => {
    const name = typeof plugin.name === 'string' ? plugin.name : '';
    const packageName = typeof plugin.packageName === 'string' ? plugin.packageName : '';
    const dbVersion = typeof plugin.version === 'string' ? plugin.version : undefined;
    const nodeStates = snapshots.map((snapshot) => {
      const nodePlugin = snapshot.plugins.find((item) => item.name === name || item.packageName === packageName);
      return {
        nodeId: snapshot.nodeId,
        hostname: snapshot.node.hostname,
        loaded: Boolean(nodePlugin?.loaded),
        runtimeVersion: nodePlugin?.runtimeVersion,
      };
    });
    const runtimeVersions = Array.from(
      new Set(nodeStates.filter((item) => item.loaded && item.runtimeVersion).map((item) => item.runtimeVersion)),
    );
    const hasVersionMismatch =
      runtimeVersions.length > 1 ||
      Boolean(dbVersion && runtimeVersions.some((version) => version && version !== dbVersion));
    const loadedValues = new Set(nodeStates.map((item) => item.loaded));

    return {
      name,
      packageName,
      enabled: Boolean(plugin.enabled),
      dbVersion,
      runtimeVersions,
      versionDrift: hasVersionMismatch,
      loadDrift: Boolean(plugin.enabled) && loadedValues.size > 1,
      nodes: nodeStates,
    };
  });

  return {
    plugins,
    versionDrifts: plugins.filter((plugin) => plugin.versionDrift),
    loadDrifts: plugins.filter((plugin) => plugin.loadDrift),
  };
}

async function getExpectedPackages(app: Application): Promise<NormalizedPackages> {
  try {
    const repo = getRepository(app, 'workerPackagesConfigs');
    const config = await repo.findOne();
    if (!config) {
      return normalizePackageMap(packagesFromConfig({}));
    }
    const configured = packagesFromConfig({
      aptPackages: getModelValue(config, 'aptPackages'),
      pythonPackages: getModelValue(config, 'pythonPackages'),
      npmPackages: getModelValue(config, 'npmPackages'),
    });
    const custom = parseCustomPackages(getModelValue(config, 'customPackages'));
    return normalizePackageMap({
      apt: configured.apt,
      npm: [...(configured.npm || []), ...(custom.node || []), ...(custom.npm || [])],
      python: [...(configured.python || []), ...(custom.python || [])],
    });
  } catch {
    return { apt: [], npm: [], python: [] };
  }
}

async function getPackageDiagnostics(app: Application, nodes: DoctorNodeRecord[]) {
  const redis = getRedisClient(app) as RedisLike | null;
  const expectedPackages = await getExpectedPackages(app);
  const nodePackages = [];

  if (!redis) {
    return {
      available: false,
      expectedPackages,
      nodes: [],
      packageDrifts: [],
    };
  }

  for (const node of nodes.filter((item) => getNodeRole(item) !== 'app')) {
    const keys = [
      node.id ? `cluster-manager:pkg-status:${node.id}` : null,
      node.hostname ? `orchestrator:pkg-status:${node.hostname}` : null,
      node.name ? `orchestrator:pkg-status:${node.name}` : null,
    ].filter(Boolean) as string[];
    let status: Record<string, unknown> | null = null;
    for (const key of keys) {
      const raw = await redis.sendCommand(['GET', key]);
      if (typeof raw === 'string' && raw) {
        status = parseJson<Record<string, unknown> | null>(raw, null);
        if (status) break;
      }
    }
    const installedPackages = parsePackageWhitelist(status?.packageWhitelist);
    const missingPackages = diffPackages(expectedPackages, installedPackages);
    nodePackages.push({
      nodeId: node.id,
      hostname: node.hostname,
      role: getNodeRole(node),
      status: status?.initStatus || 'unknown',
      lastInitAt: status?.lastInitAt || null,
      installedPackages,
      missingPackages,
      drift: !status || status.initStatus !== 'succeeded' || countPackages(missingPackages) > 0,
    });
  }

  return {
    available: true,
    expectedPackages,
    nodes: nodePackages,
    packageDrifts: nodePackages.filter((item) => item.drift),
  };
}

async function safeCount(app: Application, collection: string, filter?: Record<string, unknown>) {
  try {
    if (getApp(app).db.hasCollection && !getApp(app).db.hasCollection(collection)) {
      return null;
    }
    const repo = getRepository(app, collection);
    if (!repo.count) return null;
    return await repo.count(filter ? { filter } : undefined);
  } catch {
    return null;
  }
}

async function getDatabaseDiagnostics(app: Application) {
  const startedAt = Date.now();
  let ping: { ok: boolean; latencyMs?: number; error?: string };
  try {
    await getApp(app).db.sequelize?.query('SELECT 1');
    ping = { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    ping = { ok: false, error: getErrorMessage(error) };
  }

  return {
    ping,
    asyncTasks: {
      pending: await safeCount(app, 'asyncTasks', { status: null }),
      running: await safeCount(app, 'asyncTasks', { status: 0 }),
      failed: await safeCount(app, 'asyncTasks', { status: -1 }),
      canceled: await safeCount(app, 'asyncTasks', { status: -2 }),
    },
    workflowExecutions: {
      queued: await safeCount(app, 'executions', { status: null }),
      running: await safeCount(app, 'executions', { status: 0 }),
      failed: await safeCount(app, 'executions', { status: -1 }),
      canceled: await safeCount(app, 'executions', { status: -4 }),
    },
    jobs: {
      pending: await safeCount(app, 'jobs', { status: 0 }),
      failed: await safeCount(app, 'jobs', { status: -1 }),
      canceled: await safeCount(app, 'jobs', { status: -4 }),
    },
    applicationPlugins: {
      total: await safeCount(app, 'applicationPlugins'),
      enabled: await safeCount(app, 'applicationPlugins', { enabled: true }),
      disabled: await safeCount(app, 'applicationPlugins', { enabled: false }),
    },
  };
}

function parseRedisInfo(raw: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let current = 'default';
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      current = trimmed.replace(/^#\s*/, '').toLowerCase();
      sections[current] = sections[current] || {};
      continue;
    }
    const idx = trimmed.indexOf(':');
    if (idx > 0) {
      sections[current] = sections[current] || {};
      sections[current][trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  }
  return sections;
}

async function getRedisDiagnostics(app: Application) {
  const redis = getRedisClient(app) as RedisLike | null;
  if (!redis) {
    return { available: false };
  }

  try {
    const startedAt = Date.now();
    await redis.sendCommand(['PING']);
    const rawInfo = typeof redis.info === 'function' ? await redis.info() : String(await redis.sendCommand(['INFO']));
    const info = parseRedisInfo(rawInfo);
    const memory = info.memory || {};
    const stats = info.stats || {};
    const clients = info.clients || {};
    const dbSize = Number(await redis.sendCommand(['DBSIZE'])) || 0;
    const lockKeys = await scanKeys(redis, 'nocobase:lock:*', 200);
    const rawSlowlog = (await redis.sendCommand(['SLOWLOG', 'GET', '10'])) as unknown[];
    const slowlog = Array.isArray(rawSlowlog)
      ? rawSlowlog.map((entry) => {
          const item = Array.isArray(entry) ? entry : [];
          const command = Array.isArray(item[3]) ? item[3].join(' ') : String(item[3] || '');
          return {
            id: item[0],
            timestamp: item[1],
            durationUs: item[2],
            command: redactText(command),
          };
        })
      : [];
    return {
      available: true,
      latencyMs: Date.now() - startedAt,
      memory: {
        used: memory.used_memory_human,
        usedBytes: Number(memory.used_memory || 0),
        peak: memory.used_memory_peak_human,
        fragmentationRatio: Number(memory.mem_fragmentation_ratio || 0),
      },
      clients: {
        connected: Number(clients.connected_clients || 0),
        blocked: Number(clients.blocked_clients || 0),
      },
      stats: {
        opsPerSec: Number(stats.instantaneous_ops_per_sec || 0),
        evictedKeys: Number(stats.evicted_keys || 0),
        expiredKeys: Number(stats.expired_keys || 0),
      },
      dbSize,
      activeLocks: lockKeys.length,
      slowlog,
    };
  } catch (error) {
    return { available: false, error: getErrorMessage(error) };
  }
}

async function getQueueDiagnostics(app: Application) {
  const eventQueue = getApp(app).eventQueue as unknown as
    | {
        isConnected?(): boolean;
        adapter?: unknown;
        events?: Map<string, { concurrency?: number; interval?: number; shared?: boolean }>;
        getFullChannel?(channel: string, shared?: boolean): string;
      }
    | undefined;

  if (!eventQueue) {
    return { available: false };
  }

  const adapter = eventQueue.adapter as
    | { constructor?: { name?: string }; queues?: Map<string, unknown[]> }
    | undefined;
  const channels = [];
  for (const [channel, options] of eventQueue.events || new Map()) {
    let pending: number | null = null;
    if (adapter?.queues && eventQueue.getFullChannel) {
      const fullChannel = eventQueue.getFullChannel(channel, options.shared);
      pending = adapter.queues.get(fullChannel)?.length || 0;
    }
    channels.push({
      channel,
      concurrency: options.concurrency || 1,
      interval: options.interval || 250,
      pending,
    });
  }

  return {
    available: true,
    connected: eventQueue.isConnected?.() || false,
    adapter: adapter?.constructor?.name || 'unknown',
    channels,
    totalPending: channels.reduce((sum, item) => sum + (item.pending || 0), 0),
  };
}

async function getOrchestratorDiagnostics(app: Application, options: DoctorSnapshotOptions) {
  const plugin = getApp(app).pm?.get('plugin-cluster-manager') as {
    orchestrator?: {
      name: string;
      listContainers(stack: StackConfig): Promise<ContainerInfo[]>;
      getLogs(containerId: string, tail?: number): Promise<string>;
      getStats(containerId: string): Promise<unknown>;
    };
  } | null;
  const adapter = plugin?.orchestrator;
  if (!adapter) {
    return { configured: false, stacks: [] };
  }

  let stacks: StackConfig[] = [];
  try {
    const repo = getRepository(app, 'orchestratorStacks');
    const rows = await repo.find({ sort: ['name'], limit: 10 });
    stacks = rows.map((row) => modelToJSON(row) as unknown as StackConfig).filter((stack) => stack?.enabled !== false);
  } catch (error) {
    return { configured: true, adapter: adapter.name, error: getErrorMessage(error), stacks: [] };
  }

  const results = [];
  for (const stack of stacks) {
    try {
      const containers = await adapter.listContainers(stack);
      const enriched = [];
      for (const container of containers.slice(0, 10)) {
        let stats: unknown = null;
        let logs: { lineCount: number; analysis: LogAnalysis; error?: string } | null = null;
        try {
          stats = container.status === 'running' ? await adapter.getStats(container.id) : null;
        } catch (error) {
          stats = { error: getErrorMessage(error) };
        }
        try {
          const rawLogs = await adapter.getLogs(container.id, MAX_CONTAINER_LOG_LINES);
          const parsed = rawLogs
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .map((line) => parseDiagnosticLine(`container:${container.name}`, line))
            .filter((line) => {
              const timestamp = line.timestamp ? Date.parse(line.timestamp) : parseLogTimestamp(line.line);
              if (!timestamp) return true;
              return timestamp >= (options.sinceMs || 0) && timestamp <= (options.untilMs || Date.now());
            });
          logs = { lineCount: parsed.length, analysis: analyzeLogLines(parsed) };
        } catch (error) {
          logs = { lineCount: 0, analysis: analyzeLogLines([]), error: getErrorMessage(error) };
        }
        enriched.push({ ...container, stats, logs });
      }
      results.push({ stack: { id: stack.id, name: stack.name, adapter: stack.adapter }, containers: enriched });
    } catch (error) {
      results.push({
        stack: { id: stack.id, name: stack.name, adapter: stack.adapter },
        error: getErrorMessage(error),
      });
    }
  }

  return {
    configured: true,
    adapter: adapter.name,
    stacks: results,
  };
}

function buildRecommendations(params: {
  snapshotErrors: number;
  topErrors: number;
  versionDrift: boolean;
  runtimeDrift: boolean;
  pluginVersionDrifts: number;
  pluginLoadDrifts: number;
  packageDrifts: number;
  redisAvailable: boolean;
  databaseOk: boolean;
}) {
  const recommendations = [];
  if (!params.redisAvailable) {
    recommendations.push({
      level: 'critical',
      code: 'redis_unavailable',
      message: 'Redis is unavailable, so cluster-wide diagnostic collection and locking are degraded.',
    });
  }
  if (!params.databaseOk) {
    recommendations.push({
      level: 'critical',
      code: 'database_unhealthy',
      message: 'Database ping failed during the diagnostic session.',
    });
  }
  if (params.snapshotErrors > 0) {
    recommendations.push({
      level: 'warning',
      code: 'snapshot_collection_failed',
      message: `${params.snapshotErrors} node(s) did not return a diagnostic snapshot.`,
    });
  }
  if (params.versionDrift || params.runtimeDrift) {
    recommendations.push({
      level: 'warning',
      code: 'cluster_runtime_drift',
      message: 'Cluster nodes are not running the same application/runtime version.',
    });
  }
  if (params.pluginVersionDrifts > 0 || params.pluginLoadDrifts > 0) {
    recommendations.push({
      level: 'warning',
      code: 'plugin_drift',
      message: 'Installed or loaded plugin state is inconsistent across diagnostic snapshots.',
    });
  }
  if (params.packageDrifts > 0) {
    recommendations.push({
      level: 'warning',
      code: 'package_drift',
      message: 'One or more worker nodes are missing configured packages or have failed package initialization.',
    });
  }
  if (params.topErrors > 0) {
    recommendations.push({
      level: 'warning',
      code: 'log_errors_detected',
      message: 'Error or warning signatures were found in node/container logs during the diagnostic window.',
    });
  }
  return recommendations;
}

async function buildDoctorReport(app: Application, run: Record<string, unknown>, finishReason: string) {
  const runId = String(run.runId);
  const startedAt = new Date(String(run.startedAt));
  const finishedAt = new Date();
  const sinceMs = startedAt.getTime();
  const untilMs = finishedAt.getTime();
  const nodes = await getClusterNodes(app);
  const snapshots = await collectNodeSnapshots(app, nodes, {
    runId,
    sinceMs,
    untilMs,
    maxLines: MAX_NODE_LOG_LINES,
  });
  const pluginRows = await getApplicationPluginRows(app);
  const versionDiagnostics = buildVersionDiagnostics(nodes, snapshots);
  const pluginDiagnostics = buildPluginDiagnostics(pluginRows, snapshots);
  const packageDiagnostics = await getPackageDiagnostics(app, nodes);
  const databaseDiagnostics = await getDatabaseDiagnostics(app);
  const redisDiagnostics = await getRedisDiagnostics(app);
  const queueDiagnostics = await getQueueDiagnostics(app);
  const orchestratorDiagnostics = await getOrchestratorDiagnostics(app, { sinceMs, untilMs });
  const topSignatures = aggregateTopSignatures(snapshots, orchestratorDiagnostics);
  const snapshotErrors = snapshots.filter((snapshot) => snapshot.error).length;
  const recommendations = buildRecommendations({
    snapshotErrors,
    topErrors: topSignatures.length,
    versionDrift: Boolean(versionDiagnostics.versionDrift),
    runtimeDrift: Boolean(versionDiagnostics.runtimeDrift),
    pluginVersionDrifts: pluginDiagnostics.versionDrifts.length,
    pluginLoadDrifts: pluginDiagnostics.loadDrifts.length,
    packageDrifts: packageDiagnostics.packageDrifts.length,
    redisAvailable: Boolean(redisDiagnostics.available),
    databaseOk: Boolean(databaseDiagnostics.ping.ok),
  });
  const criticalFindings = recommendations.filter((item) => item.level === 'critical').length;
  const warningFindings = recommendations.filter((item) => item.level === 'warning').length;
  const healthStatus = criticalFindings > 0 ? 'critical' : warningFindings > 0 ? 'warning' : 'healthy';
  const summary = {
    status: healthStatus,
    nodes: snapshots.length,
    snapshotErrors,
    errors: topSignatures.filter((item) => item.level === 'error').reduce((sum, item) => sum + item.count, 0),
    warnings: topSignatures.filter((item) => item.level === 'warn').reduce((sum, item) => sum + item.count, 0),
    versionDrift: versionDiagnostics.versionDrift,
    runtimeDrift: versionDiagnostics.runtimeDrift,
    pluginVersionDrifts: pluginDiagnostics.versionDrifts.length,
    pluginLoadDrifts: pluginDiagnostics.loadDrifts.length,
    packageDrifts: packageDiagnostics.packageDrifts.length,
    failedTasks: databaseDiagnostics.asyncTasks.failed,
    failedWorkflows: databaseDiagnostics.workflowExecutions.failed,
  };

  return {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: untilMs - sinceMs,
    requestedDurationMs: Number(run.durationMs || 0),
    finishReason,
    summary,
    nodes: snapshots,
    versionDiagnostics,
    pluginDiagnostics,
    packageDiagnostics,
    databaseDiagnostics,
    redisDiagnostics,
    queueDiagnostics,
    orchestratorDiagnostics,
    logAnalysis: {
      topSignatures,
      byNode: snapshots.map((snapshot) => ({
        nodeId: snapshot.nodeId,
        hostname: snapshot.node.hostname,
        role: snapshot.node.role,
        files: snapshot.logs.files,
        levels: snapshot.logs.analysis.levels,
        signatures: snapshot.logs.analysis.signatures.slice(0, 10),
        error: snapshot.error,
      })),
    },
    recommendations,
  };
}

async function finishDoctorRun(app: Application, runId: string, reason: string) {
  const hasFinishLock = await acquireFinishLock(app, runId);
  if (!hasFinishLock) {
    return modelToJSON(await getRunById(app, runId));
  }

  clearRunTimer(runId);
  try {
    const run = await getRunById(app, runId);
    const runJson = modelToJSON(run);
    if (!run || !runJson) {
      throw new Error(`Diagnostic run ${runId} was not found.`);
    }
    if (runJson.status !== 'running') {
      await releaseActiveRun(app, runId);
      return runJson;
    }

    await updateRun(app, runId, { progress: 40 });
    const report = await buildDoctorReport(app, runJson, reason);
    await updateRun(app, runId, {
      status: 'finished',
      progress: 100,
      finishedAt: new Date(),
      finishReason: reason,
      summary: report.summary,
      report,
      error: null,
    });
    await releaseActiveRun(app, runId);
    return modelToJSON(await getRunById(app, runId));
  } catch (error) {
    await updateRun(app, runId, {
      status: 'failed',
      progress: 100,
      finishedAt: new Date(),
      finishReason: reason,
      error: getErrorMessage(error),
    });
    await releaseActiveRun(app, runId);
    throw error;
  } finally {
    await releaseFinishLock(app, runId);
  }
}

async function finishExpiredActiveRun(app: Application) {
  const activeRun = await getActiveRunState(app);
  if (activeRun && Date.parse(activeRun.deadlineAt) <= Date.now()) {
    await finishDoctorRun(app, activeRun.runId, 'timeout');
    return;
  }

  const latestRun = modelToJSON(await getLatestRun(app));
  if (
    latestRun?.status === 'running' &&
    latestRun.deadlineAt &&
    Date.parse(String(latestRun.deadlineAt)) <= Date.now()
  ) {
    await finishDoctorRun(app, String(latestRun.runId), 'timeout');
  }
}

function sanitizeRunForResponse(run: Record<string, unknown> | null, includeReport = false) {
  if (!run) return null;
  if (includeReport) return run;
  const { report, ...rest } = run;
  return {
    ...rest,
    hasReport: Boolean(report),
  };
}

export const doctorActions = {
  async start(ctx: Context, next: () => Promise<void>) {
    const payload = getPayload(ctx);
    const durationMs = clampDuration(payload.durationMs);
    const startedAt = new Date();
    const deadlineAt = new Date(startedAt.getTime() + durationMs);
    const runId = crypto.randomBytes(8).toString('hex');
    const activeState: DoctorActiveState = {
      runId,
      startedAt: startedAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
      durationMs,
      startedBy: getUserLabel(ctx),
    };

    try {
      await finishExpiredActiveRun(ctx.app);
      const blockingRun = await getBlockingRunStateFromDb(ctx.app);
      if (blockingRun) {
        throw new ActiveDoctorRunError(blockingRun);
      }
      await acquireActiveRun(ctx.app, activeState);
    } catch (error) {
      if (error instanceof ActiveDoctorRunError) {
        ctx.throw(409, 'A diagnostic session is already running.', {
          activeRun: error.activeRun,
        });
      }
      throw error;
    }

    try {
      const repo = getRepository(ctx.app, 'clusterManagerDoctorRuns');
      await repo.create({
        values: {
          runId,
          status: 'running',
          durationMs,
          progress: 5,
          startedAt,
          deadlineAt,
          startedBy: activeState.startedBy,
        },
      });
      scheduleAutoFinish(ctx.app, runId, deadlineAt.toISOString());
      getApp(ctx.app).logger.info(`[ClusterDoctor] Diagnostic run ${runId} started by ${activeState.startedBy}`);
      ctx.body = {
        success: true,
        runId,
        status: 'running',
        startedAt: activeState.startedAt,
        deadlineAt: activeState.deadlineAt,
        durationMs,
      };
    } catch (error) {
      await releaseActiveRun(ctx.app, runId);
      throw error;
    }

    await next();
  },

  async stop(ctx: Context, next: () => Promise<void>) {
    const payload = getPayload(ctx);
    await finishExpiredActiveRun(ctx.app);
    const activeRun = await getActiveRunState(ctx.app);
    const runId = String(payload.runId || activeRun?.runId || ctx.action.params.runId || '');
    if (!runId) {
      ctx.throw(404, 'No active diagnostic session was found.');
    }

    const run = await finishDoctorRun(ctx.app, runId, 'manual');
    ctx.body = sanitizeRunForResponse(run, true);
    await next();
  },

  async status(ctx: Context, next: () => Promise<void>) {
    await finishExpiredActiveRun(ctx.app);
    const activeRun = await getActiveRunState(ctx.app);
    const runId = String(ctx.action.params.runId || activeRun?.runId || '');
    const run = runId ? await getRunById(ctx.app, runId) : await getLatestRun(ctx.app);
    ctx.body = {
      activeRun,
      run: sanitizeRunForResponse(modelToJSON(run), false),
    };
    await next();
  },

  async report(ctx: Context, next: () => Promise<void>) {
    await finishExpiredActiveRun(ctx.app);
    const runId = String(ctx.action.params.runId || '');
    const run = runId ? await getRunById(ctx.app, runId) : await getLatestRun(ctx.app);
    const runJson = modelToJSON(run);
    if (!runJson) {
      ctx.throw(404, 'Diagnostic report not found.');
    }
    ctx.body = sanitizeRunForResponse(runJson, true);
    await next();
  },

  async download(ctx: Context, next: () => Promise<void>) {
    await finishExpiredActiveRun(ctx.app);
    const runId = String(ctx.action.params.runId || '');
    const run = runId ? await getRunById(ctx.app, runId) : await getLatestRun(ctx.app);
    const runJson = modelToJSON(run);
    if (!runJson?.report) {
      ctx.throw(404, 'Diagnostic report not found.');
    }

    ctx.attachment(`doctor-report-${runJson.runId}.json`);
    ctx.set('Content-Type', 'application/json; charset=utf-8');
    ctx.body = JSON.stringify(runJson.report, null, 2);
    await next();
  },
};
