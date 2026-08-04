import { Migration } from '@nocobase/server';
import { validateHarnessSettings } from '../services/HarnessSchema';
import { loopPatternPolicySchema } from '../services/LoopPatternSchema';
import { ensureAgentOrchestratorIndexes } from '../utils/ensure-indexes';

type MigrationRecord = Record<string, unknown> & {
  get?: (key: string) => unknown;
  toJSON?: () => Record<string, unknown>;
};

type MigrationRepository = {
  find(options?: Record<string, unknown>): Promise<MigrationRecord[]>;
  findOne(options: Record<string, unknown>): Promise<MigrationRecord | null>;
  create(options: Record<string, unknown>): Promise<MigrationRecord>;
  update(options: Record<string, unknown>): Promise<unknown>;
};

type MigrationDatabase = {
  getRepository(name: string): MigrationRepository | undefined;
  sequelize: {
    transaction<T>(callback: (transaction: unknown) => Promise<T>): Promise<T>;
  };
};

const LEGACY_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'rejected', 'canceled']);
const CONTROL_PLANE_STATUSES = new Set([
  'queued',
  'preparing',
  'waiting_lock',
  'running',
  'waiting_approval',
  'verifying',
  'waiting_human',
  'paused',
  'blocked',
  'succeeded',
  'failed',
  'canceled',
]);
const LEGACY_PLAN_STATUSES = new Set([
  'planning',
  'waiting_plan_approval',
  'approved',
  'waiting_user',
  'needs_replan',
  'rejected',
]);

const BACKFILL_BATCH_SIZE = 500;

async function* iterateInBatches(
  repository: MigrationRepository,
  options: Record<string, unknown> = {},
): AsyncGenerator<MigrationRecord> {
  let page = 1;
  for (;;) {
    const batch = await repository.find({ ...options, sort: ['id'], page, pageSize: BACKFILL_BATCH_SIZE });
    if (!batch.length) return;
    for (const record of batch) {
      yield record;
    }
    if (batch.length < BACKFILL_BATCH_SIZE) return;
    page += 1;
  }
}

function readValue(record: MigrationRecord, key: string) {
  return typeof record.get === 'function' ? record.get(key) : record[key];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function positiveInteger(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function isPublishedValidVersion(version: MigrationRecord) {
  return (
    readValue(version, 'status') === 'published' && validateHarnessSettings(readValue(version, 'settings')).success
  );
}

async function backfillHarnessProfiles(db: MigrationDatabase) {
  const profiles = db.getRepository('agentHarnessProfiles');
  const versions = db.getRepository('agentHarnessProfileVersions');
  if (!profiles || !versions) return;

  for await (const profile of iterateInBatches(profiles)) {
    const profileId = positiveInteger(readValue(profile, 'id'));
    if (!profileId) continue;

    await db.sequelize.transaction(async (transaction) => {
      const allVersions = await versions.find({ filter: { profileId }, sort: ['-version'], transaction });
      const currentVersionId = positiveInteger(readValue(profile, 'currentVersionId'));
      const current = currentVersionId ? await versions.findOne({ filterByTk: currentVersionId, transaction }) : null;
      if (current && isPublishedValidVersion(current)) return;

      const published = allVersions.find(isPublishedValidVersion);
      if (published) {
        const publishedId = positiveInteger(readValue(published, 'id'));
        if (publishedId && currentVersionId !== publishedId) {
          await profiles.update({
            filterByTk: profileId,
            values: { currentVersionId: publishedId },
            transaction,
          });
        }
        return;
      }

      const settingsResult = validateHarnessSettings(readValue(profile, 'settings'));
      if (!settingsResult.success) return;
      const settings = settingsResult.data;
      const nextVersion =
        allVersions.reduce((maximum, version) => Math.max(maximum, Number(readValue(version, 'version')) || 0), 0) + 1;
      const version = await versions.create({
        values: {
          profileId,
          version: nextVersion,
          schemaVersion: positiveInteger(readValue(profile, 'schemaVersion')) || 1,
          status: 'published',
          settings,
          publishedAt: readValue(profile, 'updatedAt') || readValue(profile, 'createdAt') || new Date(),
        },
        transaction,
      });
      const versionId = positiveInteger(readValue(version, 'id'));
      if (versionId) {
        await profiles.update({
          filterByTk: profileId,
          values: { currentVersionId: versionId },
          transaction,
        });
      }
    });
  }
}

function hasLegacyPlanFields(run: MigrationRecord, status: string) {
  const metadata = asObject(readValue(run, 'metadata'));
  return (
    LEGACY_PLAN_STATUSES.has(status) ||
    Boolean(stringValue(readValue(run, 'planSource')).trim()) ||
    Boolean(stringValue(readValue(run, 'plannerModel')).trim()) ||
    Boolean(stringValue(metadata.planSource).trim()) ||
    Boolean(stringValue(metadata.plannerModel).trim()) ||
    Boolean(stringValue(metadata.approvalMode).trim())
  );
}

function isValidControlPlaneRun(run: MigrationRecord) {
  const runtimeVersion = stringValue(readValue(run, 'runtimeVersion'));
  const status = stringValue(readValue(run, 'status'));
  const patternId = positiveInteger(readValue(run, 'patternId'));
  return (
    runtimeVersion === 'control-plane-v2' &&
    CONTROL_PLANE_STATUSES.has(status) &&
    !hasLegacyPlanFields(run, status) &&
    patternId !== null &&
    loopPatternPolicySchema.safeParse(readValue(run, 'policySnapshot')).success
  );
}

async function backfillLegacyRuns(db: MigrationDatabase) {
  const runs = db.getRepository('agentLoopRuns');
  const steps = db.getRepository('agentLoopSteps');
  const events = db.getRepository('agentLoopEvents');
  if (!runs || !steps || !events) return;

  for await (const run of iterateInBatches(runs)) {
    const runId = positiveInteger(readValue(run, 'id'));
    if (!runId || isValidControlPlaneRun(run)) continue;

    const metadata = asObject(readValue(run, 'metadata'));
    const statusValue = stringValue(readValue(run, 'status'));
    const preservedLegacyStatus = stringValue(metadata.legacyStatus);
    const legacyStatus = preservedLegacyStatus || statusValue || 'unknown';
    const isTerminal = LEGACY_TERMINAL_STATUSES.has(legacyStatus);
    const correlationKey = `legacy-runtime-retired:${runId}`;
    if (readValue(run, 'runtimeVersion') === 'legacy-plan-v1' && metadata.legacyRuntimeRetired === true) continue;

    await db.sequelize.transaction(async (transaction) => {
      await runs.update({
        filterByTk: runId,
        values: {
          runtimeVersion: 'legacy-plan-v1',
          recordMode: 'legacy-plan',
          ...(isTerminal
            ? {}
            : {
                status: 'blocked',
                blockedReason: 'The legacy plan runtime was retired. This historical run is read-only.',
                lockedBy: null,
                lockedUntil: null,
              }),
          metadata: {
            ...metadata,
            legacyStatus,
            legacyRuntimeRetired: true,
          },
        },
        transaction,
      });
      await steps.update({
        filter: { runId },
        values: { runtimeVersion: 'legacy-plan-v1' },
        transaction,
      });

      if (!isTerminal) {
        const existingEvent = await events.findOne({
          filter: { runId, type: 'legacy_runtime_retired', correlationKey },
          transaction,
        });
        if (!existingEvent) {
          await events.create({
            values: {
              runId,
              type: 'legacy_runtime_retired',
              title: 'Legacy runtime retired',
              content: 'The nonterminal plan-era run was blocked during the Loop Control Plane cutover.',
              status: 'blocked',
              payload: { legacyStatus },
              actorType: 'system',
              actorIdentity: 'loop-control-plane-migration',
              correlationKey,
              createdAt: new Date(),
            },
            transaction,
          });
        }
      }
    });
  }
}

async function backfillSpanRunLinks(db: MigrationDatabase) {
  const spans = db.getRepository('agentExecutionSpans');
  if (!spans) return;

  for await (const span of iterateInBatches(spans)) {
    if (positiveInteger(readValue(span, 'agentLoopRunId'))) continue;
    const runId = positiveInteger(asObject(readValue(span, 'metadata')).agentLoopRunId);
    const spanId = positiveInteger(readValue(span, 'id'));
    if (!runId || !spanId) continue;

    await spans.update({
      filterByTk: spanId,
      values: { agentLoopRunId: runId },
    });
  }
}

async function ensureGlobalControl(db: MigrationDatabase) {
  const controls = db.getRepository('agentLoopControlSettings');
  if (!controls) return;
  const existing = await controls.findOne({ filter: { key: 'global' } });
  if (existing) return;
  await controls.create({
    values: {
      key: 'global',
      acceptNewRuns: true,
      state: 'running',
      globalMaxConcurrency: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

export async function backfillLoopControlPlaneData(db: MigrationDatabase) {
  await backfillHarnessProfiles(db);
  await backfillLegacyRuns(db);
  await backfillSpanRunLinks(db);
  await ensureGlobalControl(db);
}

export default class BackfillLoopControlPlaneData extends Migration {
  on = 'afterLoad';
  appVersion = '>=0.1.0';

  async up() {
    await backfillLoopControlPlaneData(this.db as unknown as MigrationDatabase);
    await ensureAgentOrchestratorIndexes(this.db);
  }
}
