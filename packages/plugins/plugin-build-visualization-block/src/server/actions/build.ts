import { Context, Next } from '@nocobase/actions';
import type { Repository } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import crypto from 'crypto';

import {
  BUILD_TIMEOUT_MS,
  COLLECTION_NAME,
  MAX_COLLECTIONS,
  MAX_REQUIREMENT_CHARS,
  MIN_COLLECTIONS,
  PLUGIN_NAME,
} from '../../shared/constants';
import { introspect } from '../pipeline/introspector';
import { analyze } from '../pipeline/analyzer';
import { validate } from '../pipeline/validator';
import { generate } from '../pipeline/generator';
import { buildFallbackSpec } from '../pipeline/fallback';

/**
 * The raw, untrusted shape of `ctx.action.params.values` for the build action.
 * Every field is typed as `unknown` because it arrives from the client and must
 * be narrowed/validated before use.
 */
interface BuildActionParamsValues {
  requirement?: unknown;
  collections?: unknown;
  dataSource?: unknown;
  llmService?: unknown;
  model?: unknown;
  primaryCollection?: unknown;
}

/**
 * The validated build input, produced after {@link build} narrows and checks
 * the raw `ctx.action.params.values`.
 */
interface ValidatedBuildInput {
  requirement: string;
  collections: string[];
  dataSource: string;
  primaryCollection: string;
  llmService: string;
  model: string;
}

/**
 * The message handed to the build queue. It is the seam between the `build`
 * action (which creates the record and enqueues) and the worker (which claims
 * the run and executes the pipeline).
 */
export interface BuildQueueMessage {
  /** Primary key of the {@link COLLECTION_NAME} record to build. */
  buildId: string;
  /** Current run identity, used by the worker as a stale-run guard. */
  runId: string;
  /** The user that initiated the build, or `null` for anonymous/system runs. */
  userId: string | number | null;
  /** ISO timestamp recording when the run was queued. */
  queuedAt: string;
}

/**
 * The minimal run identity the worker pipeline operates on: a record id plus the
 * run that owns it. Every persisted write is gated on `runId` so a superseded
 * run (after a retry/regenerate) can never clobber a newer run's record.
 */
interface BuildRunContext {
  buildId: string;
  runId: string;
}

/* --------------------------------------------------------------------------
 * Queue constants — all channel/key/connection names are rescoped to
 * `plugin-build-visualization-block.build*` (Req 10.2/10.3/10.4/10.7).
 * ----------------------------------------------------------------------- */

/** The event-queue job name a worker node serves for this plugin's builds. */
export const WORKER_JOB_BUILD_VISUALIZATION_PROCESS = 'build-visualization:process';

/** The in-process event-queue channel builds are published to. */
const BUILD_VISUALIZATION_QUEUE_CHANNEL = 'plugin-build-visualization-block.build';
const BUILD_VISUALIZATION_WORKER_ALIASES = [
  BUILD_VISUALIZATION_QUEUE_CHANNEL,
  'plugin-build-visualization-block:build:queue',
];
/** The pub/sub channel used to wake idle worker pollers when a build arrives. */
const BUILD_VISUALIZATION_QUEUE_WAKE_CHANNEL = 'plugin-build-visualization-block.build.wake';
/** The named Redis connection used for the cross-node build queue. */
const BUILD_VISUALIZATION_QUEUE_REDIS_CONNECTION = 'plugin-build-visualization-block.build.queue';

/** How many builds a worker processes concurrently. */
const BUILD_VISUALIZATION_QUEUE_CONCURRENCY = Math.max(
  1,
  Number.parseInt(
    process.env.BUILD_VISUALIZATION_QUEUE_CONCURRENCY || process.env.BUILD_VISUALIZATION_MAX_CONCURRENCY || '1',
    10,
  ) || 1,
);

/**
 * The per-message processing timeout. Defaults to the shared
 * {@link BUILD_TIMEOUT_MS} (30 min, Req 10.7) but can be widened (never below
 * it) via `BUILD_VISUALIZATION_QUEUE_TIMEOUT_MS`.
 */
const BUILD_VISUALIZATION_QUEUE_TIMEOUT_MS = Math.max(
  BUILD_TIMEOUT_MS,
  Number.parseInt(process.env.BUILD_VISUALIZATION_QUEUE_TIMEOUT_MS || '', 10) || BUILD_TIMEOUT_MS,
);

/** How often the worker re-polls the DB for queued builds (Redis-free path). */
const BUILD_VISUALIZATION_QUEUE_POLL_INTERVAL_MS = Math.max(
  1000,
  Number.parseInt(process.env.BUILD_VISUALIZATION_QUEUE_POLL_INTERVAL_MS || '', 10) || 5000,
);

/** TTL for the per-record run lock that serializes a single record's claim. */
const BUILD_RUN_LOCK_TTL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.BUILD_VISUALIZATION_RUN_LOCK_TTL_MS || '', 10) || 24 * 60 * 60 * 1000,
);

/** How often a claimed run refreshes its heartbeat while building. */
const BUILD_HEARTBEAT_INTERVAL_MS = Math.max(
  5_000,
  Number.parseInt(process.env.BUILD_VISUALIZATION_HEARTBEAT_MS || '', 10) || 30_000,
);

/** A build whose heartbeat is older than this is considered stale (Req 10.7). */
const BUILD_STALE_MS = Math.max(
  BUILD_HEARTBEAT_INTERVAL_MS * 2,
  Number.parseInt(process.env.BUILD_VISUALIZATION_STALE_MS || '', 10) || 120_000,
);

/* --------------------------------------------------------------------------
 * Narrow structural interfaces for the untyped app subsystems the queue uses.
 * These keep our own domain logic typed while reading through the minimal
 * surface each subsystem exposes (rather than the reference plugin's `any`).
 * ----------------------------------------------------------------------- */

/** The minimal Redis connection surface the queue relies on. */
interface RedisLikeConnection {
  sendCommand(args: string[]): Promise<unknown>;
}

/** The minimal Redis connection manager surface (resolved off the app). */
interface RedisConnectionManagerLike {
  getConnectionSync(name: string, options?: { connectionString?: string }): Promise<RedisLikeConnection>;
}

/** The pub/sub wake handler signature. */
type WakeHandler = (message?: unknown) => void | Promise<void>;

/** The minimal pub/sub manager surface (resolved off the app). */
interface PubSubManagerLike {
  publish(channel: string, message: unknown, options?: { skipSelf?: boolean }): Promise<void> | void;
  subscribe(channel: string, handler: WakeHandler): void | Promise<void>;
  unsubscribe(channel: string, handler: WakeHandler): void | Promise<void>;
}

/** The in-memory event-queue adapter surface used to clear stale local messages. */
interface EventQueueAdapterLike {
  queues?: Map<string, unknown[]>;
}

/**
 * The minimal sequelize-model surface used for atomic, run-guarded updates.
 * `app.db.getModel(...)` returns a richer model; we narrow to just the
 * conditional `update` so the stale-run guard stays typed.
 */
interface UpdatableModel {
  update(values: Record<string, unknown>, options: { where: Record<string, unknown> }): Promise<[number, ...unknown[]]>;
}

/** Resolve the optional pub/sub manager without leaking `any` into call sites. */
function getPubSubManager(app: Application): PubSubManagerLike | undefined {
  return (app as unknown as { pubSubManager?: PubSubManagerLike }).pubSubManager;
}

/** Resolve the optional Redis connection manager. */
function getRedisConnectionManager(app: Application): RedisConnectionManagerLike | undefined {
  return (app as unknown as { redisConnectionManager?: RedisConnectionManagerLike }).redisConnectionManager;
}

/** Access the event-queue adapter internals (for local memory-queue cleanup). */
function getEventQueueInternals(app: Application): {
  adapter?: EventQueueAdapterLike;
  getFullChannel?(channel: string): string;
} {
  return app.eventQueue as unknown as {
    adapter?: EventQueueAdapterLike;
    getFullChannel?(channel: string): string;
  };
}

/** Read the app's node identity (name/instanceId) for the worker-id string. */
function getAppIdentity(app: Application): { name?: string; instanceId?: string } {
  return app as unknown as { name?: string; instanceId?: string };
}

/** The build-record model, narrowed to the conditional-update surface. */
function getBuildModel(app: Application): UpdatableModel {
  return app.db.getModel(COLLECTION_NAME) as unknown as UpdatableModel;
}

/* --------------------------------------------------------------------------
 * Queue processor state scoped per app to avoid cross-app/test leakage.
 * ----------------------------------------------------------------------- */

interface BuildQueueState {
  timer: NodeJS.Timeout | null;
  kickTimer: NodeJS.Timeout | null;
  processing: boolean;
  wakeHandler: WakeHandler | null;
}

const buildQueueStates = new WeakMap<Application, BuildQueueState>();

function getBuildQueueState(app: Application): BuildQueueState {
  let state = buildQueueStates.get(app);
  if (!state) {
    state = { timer: null, kickTimer: null, processing: false, wakeHandler: null };
    buildQueueStates.set(app, state);
  }
  return state;
}

/**
 * Raised when a persisted write targets a run that is no longer current (the
 * record's `buildRunId` changed out from under us after a retry/regenerate).
 */
class StaleBuildRunError extends Error {
  constructor(buildId: string, runId: string) {
    super(`Build run ${runId} for record ${buildId} is no longer current`);
    this.name = 'StaleBuildRunError';
  }
}

/* --------------------------------------------------------------------------
 * Worker-mode detection + identity.
 * ----------------------------------------------------------------------- */

/**
 * Whether this node should process builds. Explicit WORKER_MODE queues take
 * precedence; legacy generic worker/task modes still process these jobs.
 */
function isBuildVisualizationWorker(app: Application): boolean {
  return app.serving(WORKER_JOB_BUILD_VISUALIZATION_PROCESS) || workerModeServesBuildVisualization();
}

function workerModeServesBuildVisualization(): boolean {
  const workerMode = process.env.WORKER_MODE || '';
  const workerModes = workerMode
    .split(',')
    .map((mode) => mode.trim())
    .filter(Boolean);

  return workerModes.some((mode) => {
    if (mode === '*' || mode === 'worker' || mode === 'task' || mode === WORKER_JOB_BUILD_VISUALIZATION_PROCESS) {
      return true;
    }
    return BUILD_VISUALIZATION_WORKER_ALIASES.some((alias) => mode === alias || mode.endsWith(`:${alias}`));
  });
}

/** A stable identifier for the worker that claims a run. */
function getBuildWorkerId(app: Application): string {
  const identity = getAppIdentity(app);
  return [
    process.env.HOSTNAME || process.env.COMPUTERNAME || 'worker',
    identity.name || 'app',
    identity.instanceId || '0',
    process.pid,
  ].join(':');
}

/* --------------------------------------------------------------------------
 * Run-guarded persistence helpers.
 * ----------------------------------------------------------------------- */

/**
 * Apply `values` to the record identified by `run.buildId` only while it is
 * still owned by `run.runId`. When no row matches and the write is not
 * `optional`, the run has been superseded → {@link StaleBuildRunError}.
 */
async function updateRecordForRun(
  app: Application,
  run: BuildRunContext,
  values: Record<string, unknown>,
  optional = false,
): Promise<boolean> {
  const model = getBuildModel(app);
  const [affected] = await model.update(values, {
    where: {
      id: run.buildId,
      buildRunId: run.runId,
    },
  });
  if (!affected && !optional) {
    throw new StaleBuildRunError(run.buildId, run.runId);
  }
  return affected > 0;
}

/**
 * Atomically claim a queued run for this worker: transition `queued` →
 * `analyzing` while stamping `buildStartedAt`/heartbeat/worker. The `queued`
 * predicate in the `where` clause guarantees exactly one worker wins the claim.
 */
async function claimBuildRun(app: Application, run: BuildRunContext, workerId: string): Promise<boolean> {
  const now = new Date();
  const model = getBuildModel(app);
  const [affected] = await model.update(
    {
      buildPhase: 'analyzing',
      buildStartedAt: now,
      buildHeartbeatAt: now,
      buildWorkerId: workerId,
    },
    {
      where: {
        id: run.buildId,
        status: 'building',
        buildPhase: 'queued',
        buildRunId: run.runId,
      },
    },
  );
  return affected > 0;
}

/**
 * Start a heartbeat that refreshes `buildHeartbeatAt` on an interval while a run
 * is processing. Returns a stop function. Heartbeat writes are `optional` so a
 * superseded run simply stops updating rather than throwing.
 */
function startBuildHeartbeat(app: Application, run: BuildRunContext): () => void {
  const timer = setInterval(() => {
    updateRecordForRun(app, run, { buildHeartbeatAt: new Date() }, true).catch((error) => {
      app.log?.warn?.(`[plugin-build-visualization-block] Failed to update heartbeat for build ${run.runId}`, error);
    });
  }, BUILD_HEARTBEAT_INTERVAL_MS);

  return () => clearInterval(timer);
}

/* --------------------------------------------------------------------------
 * Redis-with-DB-poll queue.
 * ----------------------------------------------------------------------- */

/** The Redis list key holding queued build messages for this app. */
function getBuildQueueRedisKey(app: Application): string {
  const appName = getAppIdentity(app).name || process.env.APP_NAME || 'main';
  return `${appName}:plugin-build-visualization-block:build:queue`;
}

/** Resolve the shared Redis connection, or `undefined` when unavailable. */
async function getBuildQueueRedis(app: Application): Promise<RedisLikeConnection | undefined> {
  const manager = getRedisConnectionManager(app);
  if (!manager?.getConnectionSync) {
    return undefined;
  }
  try {
    const connectionString = process.env.QUEUE_ADAPTER_REDIS_URL || process.env.REDIS_URL;
    return await manager.getConnectionSync(
      BUILD_VISUALIZATION_QUEUE_REDIS_CONNECTION,
      connectionString ? { connectionString } : undefined,
    );
  } catch (error) {
    app.log?.debug?.(
      `[plugin-build-visualization-block] Redis queue unavailable; DB polling fallback active: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/** Push a build message onto the Redis queue. Returns false when Redis is down. */
async function enqueueBuildToRedis(app: Application, message: BuildQueueMessage): Promise<boolean> {
  const redis = await getBuildQueueRedis(app);
  if (!redis) return false;
  try {
    await redis.sendCommand(['RPUSH', getBuildQueueRedisKey(app), JSON.stringify(message)]);
    app.log?.debug?.(
      `[plugin-build-visualization-block] Enqueued build ${message.runId} for record "${message.buildId}" to Redis`,
    );
    return true;
  } catch (error) {
    app.log?.warn?.(
      `[plugin-build-visualization-block] Failed to enqueue build to Redis; DB polling fallback active`,
      error,
    );
    return false;
  }
}

/** Wake idle worker pollers so a freshly queued build is picked up promptly. */
async function publishBuildQueueWake(app: Application, message?: BuildQueueMessage): Promise<void> {
  try {
    await getPubSubManager(app)?.publish?.(
      BUILD_VISUALIZATION_QUEUE_WAKE_CHANNEL,
      { buildId: message?.buildId, runId: message?.runId },
      { skipSelf: !isBuildVisualizationWorker(app) },
    );
  } catch (error) {
    app.log?.debug?.(
      `[plugin-build-visualization-block] Wake publish skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Pop up to `count` messages off the Redis queue. */
async function drainRedisBuildQueue(app: Application, count: number): Promise<BuildQueueMessage[]> {
  const redis = await getBuildQueueRedis(app);
  if (!redis) return [];

  const key = getBuildQueueRedisKey(app);
  const messages: BuildQueueMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    const raw = await redis.sendCommand(['LPOP', key]);
    if (!raw) break;
    try {
      messages.push(JSON.parse(String(raw)) as BuildQueueMessage);
    } catch (error) {
      app.log?.warn?.(
        `[plugin-build-visualization-block] Dropped invalid Redis build message: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return messages;
}

/**
 * Clear any stale in-memory queue messages on a non-worker node so queued DB
 * builds are only ever processed by real worker pollers.
 */
function clearLocalBuildMemoryQueue(app: Application): void {
  const eventQueue = getEventQueueInternals(app);
  const fullChannel = eventQueue.getFullChannel?.(BUILD_VISUALIZATION_QUEUE_CHANNEL);
  const { adapter } = eventQueue;
  const queue = fullChannel ? adapter?.queues?.get?.(fullChannel) : undefined;
  if (!queue?.length) return;

  adapter?.queues?.set?.(fullChannel as string, []);
  app.log?.warn?.(
    `[plugin-build-visualization-block] Cleared ${queue.length} stale local memory message(s) on non-worker node; queued DB builds will be picked up by workers`,
  );
}

/* --------------------------------------------------------------------------
 * Queue processor lifecycle + ticks.
 * ----------------------------------------------------------------------- */

/** Start the periodic DB poller + wake subscription on worker nodes. */
export function startBuildQueueProcessor(app: Application): void {
  const state = getBuildQueueState(app);
  if (!isBuildVisualizationWorker(app)) {
    app.log?.debug?.('[plugin-build-visualization-block] Build queue processor disabled on non-worker node');
    return;
  }
  if (state.timer) return;

  state.wakeHandler = async () => {
    scheduleBuildQueueTick(app, 0);
  };

  const subscribe = getPubSubManager(app)?.subscribe?.(BUILD_VISUALIZATION_QUEUE_WAKE_CHANNEL, state.wakeHandler);
  if (subscribe instanceof Promise) {
    subscribe.catch((error: unknown) => {
      app.log?.debug?.(
        `[plugin-build-visualization-block] Wake subscribe skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  state.timer = setInterval(() => scheduleBuildQueueTick(app, 0), BUILD_VISUALIZATION_QUEUE_POLL_INTERVAL_MS);
  state.timer.unref?.();
  scheduleBuildQueueTick(app, 1000);
  app.log?.info?.(
    `[plugin-build-visualization-block] Build queue processor started (interval ${BUILD_VISUALIZATION_QUEUE_POLL_INTERVAL_MS}ms)`,
  );
}

/** Stop the poller, cancel pending ticks, and unsubscribe the wake handler. */
function stopBuildVisualizationQueueProcessor(app: Application): void {
  const state = getBuildQueueState(app);
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.kickTimer) {
    clearTimeout(state.kickTimer);
    state.kickTimer = null;
  }
  if (state.wakeHandler) {
    const unsubscribe = getPubSubManager(app)?.unsubscribe?.(BUILD_VISUALIZATION_QUEUE_WAKE_CHANNEL, state.wakeHandler);
    if (unsubscribe instanceof Promise) {
      unsubscribe.catch(() => undefined);
    }
    state.wakeHandler = null;
  }
  state.processing = false;
}

/** Debounce a queue tick so bursts of wakes coalesce into one drain pass. */
function scheduleBuildQueueTick(app: Application, delayMs: number): void {
  const state = getBuildQueueState(app);
  if (state.kickTimer) return;
  state.kickTimer = setTimeout(() => {
    state.kickTimer = null;
    runBuildQueueTick(app).catch((error) => {
      app.log?.error?.('[plugin-build-visualization-block] Build queue tick failed', error);
    });
  }, delayMs);
  state.kickTimer.unref?.();
}

/**
 * One drain pass: take from Redis first, then top up from the DB so builds are
 * never stranded when Redis is unavailable. Re-entrancy is guarded so only one
 * tick runs at a time per node.
 */
async function runBuildQueueTick(app: Application): Promise<void> {
  const state = getBuildQueueState(app);
  if (state.processing || !isBuildVisualizationWorker(app)) return;

  state.processing = true;
  try {
    // Reap builds that have exceeded the 30-min processing timeout before
    // draining the queue, so each poll also fails stuck runs (Req 10.6).
    await failTimedOutBuilds(app);

    const redisMessages = await drainRedisBuildQueue(app, BUILD_VISUALIZATION_QUEUE_CONCURRENCY);
    await processBuildQueueMessages(app, redisMessages);

    const remaining = Math.max(1, BUILD_VISUALIZATION_QUEUE_CONCURRENCY - redisMessages.length);
    await processQueuedBuildsFromDb(app, remaining);
  } finally {
    state.processing = false;
  }
}

/** Build a queue message from a persisted, still-queued record. */
function createBuildQueueMessageFromRecord(record: { get(key: string): unknown }): BuildQueueMessage | null {
  const runId = record.get('buildRunId');
  if (!runId) return null;
  const queuedAtRaw = record.get('buildQueuedAt');
  const createdById = record.get('createdById');
  return {
    buildId: String(record.get('id')),
    runId: String(runId),
    userId: typeof createdById === 'number' || typeof createdById === 'string' ? createdById : null,
    queuedAt: queuedAtRaw ? new Date(queuedAtRaw as string).toISOString() : new Date().toISOString(),
  };
}

/** DB-poll fallback: pick the oldest queued builds and process them. */
async function processQueuedBuildsFromDb(app: Application, count: number): Promise<void> {
  const repository = app.db.getRepository(COLLECTION_NAME) as Repository;
  const records = await repository.find({
    filter: {
      status: 'building',
      buildPhase: 'queued',
    },
    sort: ['buildQueuedAt'],
    limit: count,
  });
  const messages = records
    .map((record) => createBuildQueueMessageFromRecord(record))
    .filter((message): message is BuildQueueMessage => message !== null);
  await processBuildQueueMessages(app, messages);
}

/** Process a batch of queue messages concurrently. */
async function processBuildQueueMessages(app: Application, messages: BuildQueueMessage[]): Promise<void> {
  if (!messages.length) return;
  await Promise.all(messages.map((message) => processQueuedBuild(app, message)));
}

/* --------------------------------------------------------------------------
 * The worker pipeline.
 * ----------------------------------------------------------------------- */

/**
 * Execute the full generation pipeline for a single claimed run:
 *
 * 1. Load the record and guard `buildRunId === run.runId` (stale otherwise).
 * 2. Phase → `analyzing`; introspect the selected collections (Req 10.2).
 * 3. Analyze (LLM + clean/parse, fallback on failure); persist any analyzer
 *    error to `errorMessage`/`buildLog` (Req 10.4 partial).
 * 4. Validate the spec against the live schema; when the validator signals a
 *    fallback, generate from the grounded fallback spec instead.
 * 5. Phase → `generating`; generate the Formily block schema. A hard generator
 *    error throws → the run is marked `failed` by the caller (Req 10.4).
 * 6. Phase → `completed` with the stored outputs (Req 10.3).
 *
 * The function never writes a partial success: it only flips to `completed`
 * after a schema is produced. Errors propagate to {@link processQueuedBuild},
 * which marks the record `failed` (StaleBuildRunError is swallowed there).
 */
async function runBuild(app: Application, db: Application['db'], run: BuildRunContext): Promise<void> {
  const repository = db.getRepository(COLLECTION_NAME) as Repository;
  const record = await repository.findById(run.buildId);

  if (!record) {
    throw new Error('Build record not found');
  }
  if (record.get('buildRunId') !== run.runId) {
    throw new StaleBuildRunError(run.buildId, run.runId);
  }

  const requirement = String(record.get('requirement') ?? '');
  const dataSource = String(record.get('dataSource') ?? 'main');
  const llmService = record.get('llmService') as string | undefined;
  const model = record.get('model') as string | undefined;
  const rawCollections = record.get('collections');
  const collections = Array.isArray(rawCollections)
    ? rawCollections.filter((name): name is string => typeof name === 'string')
    : [];

  if (!llmService || !model) {
    throw new Error('LLM service or model is missing in the build configuration');
  }

  // Phase → analyzing (Req 10.2). Reset any prior outputs for a clean run.
  await updateRecordForRun(app, run, {
    status: 'building',
    buildPhase: 'analyzing',
    buildLog: 'Analyzing collections and requirement',
    errorMessage: null,
    blockSpec: null,
    blockSchema: null,
    adjustments: null,
    usedFallback: false,
    buildHeartbeatAt: new Date(),
  });

  const summary = await introspect(app, { dataSource, collections });

  const analysis = await analyze(app, { requirement, summary, llmService, model });
  let usedFallback = analysis.usedFallback;

  // Persist the analyzer error (parse/shape/timeout/transport) as a partial
  // diagnostic even though the run continues with the fallback spec (Req 10.4).
  if (analysis.error) {
    await updateRecordForRun(
      app,
      run,
      {
        errorMessage: analysis.error,
        buildLog: `Analyzer fell back: ${analysis.error}`,
        usedFallback: true,
      },
      true,
    );
  }

  const validation = validate(analysis.spec, summary);
  usedFallback = usedFallback || validation.usedFallback;

  // When the validator gives up (unmet required role / schema unavailable) we
  // generate from the grounded fallback spec, which is guaranteed to validate
  // and produce an insertable schema. Otherwise generate from the validated
  // spec and let the generator fall back on its own if unproducible.
  const specForGeneration = validation.usedFallback ? buildFallbackSpec(summary) : validation.spec;

  // Phase → generating (Req 10.2).
  await updateRecordForRun(app, run, {
    buildPhase: 'generating',
    buildLog: 'Generating block schema',
    buildHeartbeatAt: new Date(),
  });

  const result = generate(specForGeneration, summary);
  if (!result.ok) {
    // Hard generator failure after validation (Req 10.4 / 7.6): no partial
    // schema is emitted; surface the failed node and mark the run failed.
    throw new Error(
      result.failedNode
        ? `Schema generation failed at "${result.failedNode}": ${result.error}`
        : `Schema generation failed: ${result.error}`,
    );
  }
  usedFallback = usedFallback || result.usedFallback;

  // Phase → completed with the stored outputs (Req 10.3).
  await updateRecordForRun(app, run, {
    status: 'completed',
    buildPhase: 'completed',
    blockSpec: specForGeneration,
    blockSchema: result.schema,
    adjustments: validation.adjustments,
    usedFallback,
    buildLog: usedFallback ? 'Build completed using the fallback specification' : 'Build completed successfully',
    errorMessage: null,
    buildHeartbeatAt: new Date(),
  });
}

/** Serialize claim + processing of a single record across the cluster. */
async function withBuildRunLock<T>(app: Application, buildId: string, fn: () => Promise<T>): Promise<T> {
  return app.lockManager.runExclusive(`build-visualization:run:${buildId}`, fn, BUILD_RUN_LOCK_TTL_MS);
}

/**
 * Claim and process a single queued build message. Holds the per-record lock,
 * claims the run (skipping already-claimed/stale ones), runs the pipeline under
 * a heartbeat, and marks the record `failed` on a real error. A
 * {@link StaleBuildRunError} is benign (a newer run owns the record) and is
 * logged without failing the record.
 *
 * Exported so integration tests (task 7.5) can drive a single queued record
 * through the full worker pipeline deterministically without standing up the
 * Redis/event-queue poller. Production callers reach it through the queue
 * (`registerBuildQueue`) rather than calling it directly.
 */
export async function processQueuedBuild(app: Application, message: BuildQueueMessage): Promise<void> {
  const buildId = message?.buildId;
  const runId = message?.runId;
  if (!buildId || !runId) {
    app.log?.warn?.('[plugin-build-visualization-block] Build queue message missing buildId or runId');
    return;
  }

  await withBuildRunLock(app, buildId, async () => {
    const run: BuildRunContext = { buildId, runId };
    const workerId = getBuildWorkerId(app);
    const claimed = await claimBuildRun(app, run, workerId);
    if (!claimed) {
      app.log?.info?.(
        `[plugin-build-visualization-block] Build ${runId} for record "${buildId}" was already claimed or stale`,
      );
      return;
    }

    const repository = app.db.getRepository(COLLECTION_NAME) as Repository;
    const record = await repository.findById(buildId);
    if (!record) {
      app.log?.warn?.(`[plugin-build-visualization-block] Build record "${buildId}" not found; skipping queued build`);
      return;
    }
    if (record.get('status') !== 'building') {
      app.log?.info?.(
        `[plugin-build-visualization-block] Build record "${buildId}" is ${record.get(
          'status',
        )}; skipping queued build`,
      );
      return;
    }

    const stopHeartbeat = startBuildHeartbeat(app, run);
    try {
      await runBuild(app, app.db, run);
    } catch (error) {
      if (error instanceof StaleBuildRunError) {
        app.log?.info?.(`[plugin-build-visualization-block] ${error.message}`);
        return;
      }
      app.log?.error?.('[plugin-build-visualization-block] Build worker error', error);
      await markBuildError(app, buildId, runId, error);
    } finally {
      stopHeartbeat();
    }
  });
}

/**
 * Mark a build `failed` with an error description (Req 10.4). When `runId` is
 * known the write is run-guarded; otherwise it targets the record directly.
 */
async function markBuildError(
  app: Application,
  buildId: string,
  runId: string | undefined,
  error: unknown,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  if (runId) {
    await updateRecordForRun(
      app,
      { buildId, runId },
      {
        status: 'error',
        buildPhase: 'failed',
        errorMessage,
        buildLog: errorMessage,
        buildHeartbeatAt: new Date(),
      },
      true,
    );
    return;
  }

  await (app.db.getRepository(COLLECTION_NAME) as Repository).update({
    filterByTk: buildId,
    values: {
      status: 'error',
      buildPhase: 'failed',
      errorMessage,
      buildLog: errorMessage,
    },
  });
}

/* --------------------------------------------------------------------------
 * Public queue API (wired by plugin.ts in task 7.4).
 * ----------------------------------------------------------------------- */

/**
 * Enqueue a build run for asynchronous processing.
 *
 * Order of preference (mirrors the reference plugin):
 * 1. Redis enqueue + wake — cross-node durable queue.
 * 2. On a worker node without Redis, publish to the in-process event queue
 *    with the 30-min processing timeout (Req 10.7).
 * 3. Otherwise leave the record `queued`; a worker's DB poller will pick it up.
 *
 * On a failure to enqueue, the record is marked `failed` and the error rethrown.
 */
export async function enqueueBuild(app: Application, message: BuildQueueMessage): Promise<void> {
  try {
    const queuedInRedis = await enqueueBuildToRedis(app, message);
    if (queuedInRedis) {
      await publishBuildQueueWake(app, message);
      return;
    }

    await publishBuildQueueWake(app, message);

    if (isBuildVisualizationWorker(app)) {
      await app.eventQueue.publish(BUILD_VISUALIZATION_QUEUE_CHANNEL, message, {
        timeout: BUILD_VISUALIZATION_QUEUE_TIMEOUT_MS,
        maxRetries: 0,
      });
      return;
    }

    app.log?.warn?.(
      `[plugin-build-visualization-block] Redis queue is unavailable; build ${message.runId} for record "${message.buildId}" will remain queued until a worker DB poller picks it up`,
    );
  } catch (error) {
    await markBuildError(app, message.buildId, message.runId, error);
    throw error;
  }
}

/**
 * Register the build queue: subscribe the event-queue channel, clear stale
 * local memory messages on non-worker nodes, and start the DB poller. Called
 * from the plugin's `afterStart` (task 7.4).
 */
export function registerBuildQueue(app: Application): void {
  app.eventQueue.subscribe(BUILD_VISUALIZATION_QUEUE_CHANNEL, {
    concurrency: BUILD_VISUALIZATION_QUEUE_CONCURRENCY,
    idle: () => isBuildVisualizationWorker(app),
    process: async (message: BuildQueueMessage) => {
      await processQueuedBuild(app, message);
    },
  });
  if (!isBuildVisualizationWorker(app)) {
    app.on('afterStart', () => clearLocalBuildMemoryQueue(app));
  }
}

/**
 * Unregister the build queue: unsubscribe the channel and stop the poller.
 * Called from the plugin's `beforeStop`/`beforeDestroy` (task 7.4).
 */
export function unregisterBuildQueue(app: Application): void {
  app.eventQueue.unsubscribe(BUILD_VISUALIZATION_QUEUE_CHANNEL);
  stopBuildVisualizationQueueProcessor(app);
}

/**
 * Re-queue builds left in an in-progress phase by a worker that did not finish
 * (Req 10.7). Finds `building` records whose heartbeat is stale/absent, resets
 * them to `queued` with a fresh `buildRunId`, and re-enqueues them. Called on
 * `afterStart` (task 7.4).
 */
export async function recoverInterruptedBuilds(app: Application): Promise<void> {
  const repository = app.db.getRepository(COLLECTION_NAME) as Repository;
  const model = getBuildModel(app);
  const staleBefore = new Date(Date.now() - BUILD_STALE_MS);
  const records = await repository.find({
    filter: {
      status: 'building',
      $or: [{ buildHeartbeatAt: null }, { buildHeartbeatAt: { $lt: staleBefore } }],
    },
  });

  let requeued = 0;
  for (const record of records) {
    const buildId = String(record.get('id'));
    const previousRunId = record.get('buildRunId') || null;
    const runId = String(previousRunId || crypto.randomUUID());
    const [affected] = await model.update(
      {
        buildPhase: 'queued',
        buildLog: 'Build re-queued after worker restart',
        buildRunId: runId,
        buildQueuedAt: new Date(),
        buildStartedAt: null,
        buildHeartbeatAt: null,
        buildWorkerId: null,
      },
      {
        where: {
          id: buildId,
          status: 'building',
          buildRunId: previousRunId,
        },
      },
    );

    if (!affected) {
      continue;
    }

    await enqueueBuild(app, {
      buildId,
      runId,
      userId: null,
      queuedAt: new Date().toISOString(),
    });
    requeued += 1;
  }

  if (requeued) {
    app.log?.info?.(`[plugin-build-visualization-block] Re-queued ${requeued} interrupted build(s)`);
  }
}

/**
 * Fail builds that have exceeded the 30-min processing timeout (Req 10.6).
 *
 * A build is timed out when it is still `building`, its effective start
 * (`buildStartedAt`, or `buildQueuedAt` when a worker never claimed it) is
 * older than {@link BUILD_TIMEOUT_MS}, and its `buildHeartbeatAt` is stale or
 * absent (so an actively-heartbeating run is never reaped). Matching records
 * are marked `status:'error'`, `buildPhase:'failed'` with a timeout reason,
 * leaving them in a `failed` state the user can {@link retry}.
 *
 * Each write is run-guarded on the record's `buildRunId` so a concurrent claim
 * (a worker that picked the build up between read and update) is never
 * clobbered. Called at the start of every queue tick on worker nodes.
 */
export async function failTimedOutBuilds(app: Application): Promise<void> {
  const repository = app.db.getRepository(COLLECTION_NAME) as Repository;
  const model = getBuildModel(app);
  const now = Date.now();
  const timeoutBefore = new Date(now - BUILD_TIMEOUT_MS);
  const staleBefore = new Date(now - BUILD_STALE_MS);

  const records = await repository.find({
    filter: {
      status: 'building',
      $or: [
        { buildStartedAt: { $lt: timeoutBefore } },
        { $and: [{ buildStartedAt: null }, { buildQueuedAt: { $lt: timeoutBefore } }] },
      ],
    },
  });

  let failed = 0;
  for (const record of records) {
    const heartbeatRaw = record.get('buildHeartbeatAt');
    const heartbeatStale = !heartbeatRaw || new Date(heartbeatRaw as string).getTime() < staleBefore.getTime();
    if (!heartbeatStale) {
      continue;
    }

    const buildId = String(record.get('id'));
    const previousRunId = record.get('buildRunId') ?? null;
    const [affected] = await model.update(
      {
        status: 'error',
        buildPhase: 'failed',
        errorMessage: 'Build timed out',
        buildLog: 'Build timed out',
        buildHeartbeatAt: new Date(),
      },
      {
        where: {
          id: buildId,
          status: 'building',
          buildRunId: previousRunId,
        },
      },
    );

    if (affected) {
      failed += 1;
    }
  }

  if (failed) {
    app.log?.info?.(`[plugin-build-visualization-block] Failed ${failed} timed-out build(s)`);
  }
}

/* --------------------------------------------------------------------------
 * The `build` action (input validation + record creation + enqueue).
 * ----------------------------------------------------------------------- */

/** Read the current role names off the request context. */
function getCurrentRoles(ctx: Context): string[] {
  const roles = (ctx.state as { currentRoles?: unknown })?.currentRoles;
  return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === 'string') : [];
}

function t(ctx: Context, key: string, options?: Record<string, unknown>): string {
  return ctx.t(key, { ns: PLUGIN_NAME, ...options });
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function getRecordCollections(record: { get(key: string): unknown }): string[] {
  return readStringArray(record.get('collections'));
}

function getRecordCreatedById(record: { get(key: string): unknown }): string | number | null {
  const direct = record.get('createdById');
  if (typeof direct === 'string' || typeof direct === 'number') {
    return direct;
  }
  const createdBy = record.get('createdBy');
  if (createdBy && typeof createdBy === 'object') {
    const id = (createdBy as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') {
      return id;
    }
  }
  return null;
}

function getCurrentUserId(ctx: Context): string | number | null {
  const id = ctx.auth?.user?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function sameId(left: string | number | null, right: string | number | null): boolean {
  return left !== null && right !== null && String(left) === String(right);
}

function assertBuildRecordAccess(ctx: Context, record: { get(key: string): unknown }): void {
  const roles = getCurrentRoles(ctx);
  if (roles.includes('root')) {
    return;
  }
  if (sameId(getRecordCreatedById(record), getCurrentUserId(ctx))) {
    return;
  }
  const collections = getRecordCollections(record);
  if (collections.length === 0) {
    ctx.throw(403, t(ctx, 'You do not have permission to read this build'));
  }
  assertCollectionPermissions(ctx, collections);
}

/** Narrow an unknown value to a non-empty trimmed string, or `undefined`. */
function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validate the raw action params and return a typed, normalized build input.
 * Validation failures raise `ctx.throw(...)`, which terminates the request.
 */
function validateInput(ctx: Context, values: BuildActionParamsValues): ValidatedBuildInput {
  // Req 1.4 / 1.6 — collections must be a non-empty string array within bounds.
  if (!Array.isArray(values.collections)) {
    ctx.throw(400, t(ctx, 'At least one collection is required'));
  }
  const collections = values.collections.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  );
  if (collections.length < MIN_COLLECTIONS) {
    ctx.throw(400, t(ctx, 'At least one collection is required'));
  }
  if (collections.length > MAX_COLLECTIONS) {
    ctx.throw(400, t(ctx, 'A maximum of {{max}} collections can be selected', { max: MAX_COLLECTIONS }));
  }

  // Req 3.2 / 3.3 — requirement must be a non-empty, length-bounded string.
  const requirement = asNonEmptyString(values.requirement);
  if (!requirement) {
    ctx.throw(400, t(ctx, 'A requirement is required'));
  }
  if (requirement.length > MAX_REQUIREMENT_CHARS) {
    ctx.throw(400, t(ctx, 'The requirement must be {{max}} characters or fewer', { max: MAX_REQUIREMENT_CHARS }));
  }

  // Req 4.3 — both an LLM service and a model must be selected.
  const llmService = asNonEmptyString(values.llmService);
  const model = asNonEmptyString(values.model);
  if (!llmService || !model) {
    ctx.throw(400, t(ctx, 'An LLM service and model are required'));
  }

  const dataSource = asNonEmptyString(values.dataSource) ?? 'main';
  const primaryCollection = asNonEmptyString(values.primaryCollection) ?? collections[0];

  return { requirement, collections, dataSource, primaryCollection, llmService, model };
}

/**
 * Enforce per-collection `list` permission for the current role(s).
 * Denies the request with 403 when any selected collection is not listable.
 * Req 13.2 / 13.4.
 */
function assertCollectionPermissions(ctx: Context, collections: string[]): void {
  const roles = getCurrentRoles(ctx);
  // The built-in `root` role bypasses ACL checks (consistent with other plugins).
  if (roles.includes('root')) {
    return;
  }
  const app = ctx.app as Application;
  for (const collection of collections) {
    const allowed = app.acl.can({ roles, resource: collection, action: 'list' });
    if (!allowed) {
      ctx.throw(403, t(ctx, 'You do not have permission to read collection "{{collection}}"', { collection }));
    }
  }
}

/**
 * `aiVisualizationBuilds:build` — validate the request, create a build record
 * in the `queued` phase, hand it to the build queue, and return the record id
 * immediately so the UI never blocks (Req 10.1).
 */
export async function build(ctx: Context, next: Next): Promise<void> {
  const params = ctx.action.params as { values?: BuildActionParamsValues };
  const values = params.values ?? {};

  const input = validateInput(ctx, values);
  assertCollectionPermissions(ctx, input.collections);

  const runId = crypto.randomUUID();
  const userId = ctx.auth?.user?.id ?? null;
  const repository = ctx.db.getRepository(COLLECTION_NAME) as Repository;

  const record = await repository.create({
    values: {
      requirement: input.requirement,
      collections: input.collections,
      dataSource: input.dataSource,
      primaryCollection: input.primaryCollection,
      llmService: input.llmService,
      model: input.model,
      status: 'building',
      buildPhase: 'queued',
      buildRunId: runId,
      buildQueuedAt: new Date(),
      createdById: userId,
    },
  });

  const buildId = String(record.get('id'));

  await enqueueBuild(ctx.app as Application, {
    buildId,
    runId,
    userId,
    queuedAt: new Date().toISOString(),
  });

  ctx.body = {
    id: record.get('id'),
    status: 'building',
    buildPhase: 'queued',
  };
  await next();
}

/* --------------------------------------------------------------------------
 * The `retry` and `getResult` actions.
 * ----------------------------------------------------------------------- */

/** Narrow `ctx.action.params.filterByTk` to a usable record id, or throw 400. */
function getFilterByTk(ctx: Context): string | number {
  const filterByTk = (ctx.action.params as { filterByTk?: unknown }).filterByTk;
  if (typeof filterByTk === 'number') {
    return filterByTk;
  }
  if (typeof filterByTk === 'string' && filterByTk.trim().length > 0) {
    return filterByTk;
  }
  ctx.throw(400, t(ctx, 'A build id is required'));
}

/**
 * `aiVisualizationBuilds:retry` — re-queue an existing build with the SAME
 * inputs (requirement/collections/dataSource/llmService/model are left intact)
 * and a fresh `buildRunId`. The new run identity supersedes any in-flight run
 * via the stale-run guard. Prior outputs and worker bookkeeping are cleared so
 * the record starts a clean `queued` cycle (Req 12.3). Returns the record id.
 */
export async function retry(ctx: Context, next: Next): Promise<void> {
  const filterByTk = getFilterByTk(ctx);
  const repository = ctx.db.getRepository(COLLECTION_NAME) as Repository;
  const record = await repository.findById(filterByTk);
  if (!record) {
    ctx.throw(404, t(ctx, 'Build record not found'));
  }
  assertBuildRecordAccess(ctx, record);

  const runId = crypto.randomUUID();
  const userId = ctx.auth?.user?.id ?? null;

  await repository.update({
    filterByTk,
    values: {
      status: 'building',
      buildPhase: 'queued',
      buildRunId: runId,
      buildQueuedAt: new Date(),
      buildLog: 'Build re-queued via retry',
      errorMessage: null,
      blockSchema: null,
      blockSpec: null,
      adjustments: null,
      usedFallback: false,
      buildStartedAt: null,
      buildHeartbeatAt: null,
      buildWorkerId: null,
    },
  });

  const buildId = String(record.get('id'));

  await enqueueBuild(ctx.app as Application, {
    buildId,
    runId,
    userId,
    queuedAt: new Date().toISOString(),
  });

  ctx.body = {
    id: record.get('id'),
    status: 'building',
    buildPhase: 'queued',
  };
  await next();
}

/**
 * `aiVisualizationBuilds:getResult` — the client's polling endpoint. Returns
 * the current phase/status plus the generated outputs for a single build
 * (Req 9.4). Responds 404 when the record does not exist.
 */
export async function getResult(ctx: Context, next: Next): Promise<void> {
  const filterByTk = getFilterByTk(ctx);
  const repository = ctx.db.getRepository(COLLECTION_NAME) as Repository;
  const record = await repository.findById(filterByTk);
  if (!record) {
    ctx.throw(404, t(ctx, 'Build record not found'));
  }
  assertBuildRecordAccess(ctx, record);

  ctx.body = {
    id: record.get('id'),
    status: record.get('status'),
    buildPhase: record.get('buildPhase'),
    blockSchema: record.get('blockSchema'),
    blockSpec: record.get('blockSpec'),
    adjustments: record.get('adjustments'),
    usedFallback: record.get('usedFallback'),
    errorMessage: record.get('errorMessage'),
  };
  await next();
}
