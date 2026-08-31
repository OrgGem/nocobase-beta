import {
  FEEDBACK_OUTCOMES,
  UNHEALABLE_FAILURE_TYPES,
  type EntryStatus,
  type ReportRequestPayload,
  type SelectorType,
} from '../../constants';
import { SelectorRegistryError } from './errors';
import type { DatabaseLike, RepositoryLike } from './resolve-pipeline';
import type { SelectorSettingsService } from './settings-service';
import { read, toNumber, type AnyRecord } from '../utils/record-helpers';

export interface FeedbackServiceOptions {
  database: DatabaseLike;
  settings: SelectorSettingsService;
  now?: () => Date;
}

export interface ReportResult {
  recorded: boolean;
  entryStatus?: EntryStatus;
  confidence?: number;
  rolledBack?: boolean;
  newSelector?: string | null;
  newSelectorType?: SelectorType;
  version?: number;
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

export class FeedbackService {
  private readonly now: () => Date;

  constructor(private readonly options: FeedbackServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private repo(name: string): RepositoryLike {
    return this.options.database.getRepository(name);
  }

  async report(payload: ReportRequestPayload): Promise<ReportResult> {
    if (!payload.app?.trim()) {
      throw new SelectorRegistryError('MISSING_APP', 400, 'The "app" field is required.');
    }
    if (!payload.elementKey?.trim()) {
      throw new SelectorRegistryError('ELEMENT_KEY_REQUIRED', 400, 'The "elementKey" field is required.');
    }
    if (!FEEDBACK_OUTCOMES.includes(payload.outcome)) {
      throw new SelectorRegistryError('INVALID_OUTCOME', 400, `Invalid outcome "${payload.outcome}".`);
    }

    const app = await this.repo('selectorApps').findOne({ filter: { name: payload.app.trim() } });
    if (!app) {
      throw new SelectorRegistryError('APP_NOT_FOUND', 404, `Selector app "${payload.app}" is not registered.`);
    }
    const appId = read(app, 'id');
    const entry = await this.repo('selectorEntries').findOne({
      filter: { appId, elementKey: payload.elementKey.trim() },
    });

    await this.repo('selectorFeedbacks').create({
      values: {
        entryId: entry ? read(entry, 'id') : null,
        appId,
        elementKey: payload.elementKey.trim(),
        selectorUsed: payload.selectorUsed ?? null,
        outcome: payload.outcome,
        failureType: payload.failureType ?? null,
        signatureMatch: payload.signatureMatch ?? null,
        pageUrl: payload.pageUrl ?? null,
        pageHealth: payload.pageHealth ?? null,
        errorMessage: payload.errorMessage ?? null,
        agentId: payload.agentId ?? null,
        runId: payload.runId ?? null,
      },
    });

    if (!entry) return { recorded: true };

    // Dirty evidence: the failure says the page was broken, not the selector.
    // Do not let it touch confidence or lifecycle.
    if (payload.failureType && UNHEALABLE_FAILURE_TYPES.includes(payload.failureType)) {
      return {
        recorded: true,
        entryStatus: read(entry, 'status') as EntryStatus,
        confidence: toNumber(read(entry, 'confidence'), 0.5),
        version: toNumber(read(entry, 'version'), 1),
      };
    }

    const settings = await this.options.settings.get();
    const success = payload.outcome === 'success' || payload.outcome === 'verified';
    return success ? this.applySuccess(entry, payload, settings) : this.applyFailure(entry, payload, settings);
  }

  private ewma(current: number, outcomeValue: number, alpha: number): number {
    return round4((1 - alpha) * current + alpha * outcomeValue);
  }

  private async applySuccess(
    entry: AnyRecord,
    payload: ReportRequestPayload,
    settings: Awaited<ReturnType<SelectorSettingsService['get']>>,
  ): Promise<ReportResult> {
    const nowIso = this.now().toISOString();
    const status = read(entry, 'status') as EntryStatus;
    const confidence = this.ewma(toNumber(read(entry, 'confidence'), 0.5), 1, settings.ewmaAlpha);

    let nextStatus: EntryStatus = status;
    let probationSuccessCount = toNumber(read(entry, 'probationSuccessCount'));
    if (status === 'probation') {
      probationSuccessCount += 1;
      if (probationSuccessCount >= settings.probationSuccessTarget) nextStatus = 'active';
    } else if (status === 'degraded' && confidence >= settings.confidenceThreshold) {
      nextStatus = 'active';
    }
    // quarantined stays sticky: only an admin can restore it.

    await this.repo('selectorEntries').update({
      filterByTk: read(entry, 'id'),
      values: {
        successCount: toNumber(read(entry, 'successCount')) + 1,
        failStreak: 0,
        lastSuccessAt: nowIso,
        lastUsedAt: nowIso,
        confidence,
        confidenceUpdatedAt: nowIso,
        status: nextStatus,
        probationSuccessCount,
      },
    });
    await this.bumpVersionCounter(entry, payload, 'successCount');

    return { recorded: true, entryStatus: nextStatus, confidence, version: toNumber(read(entry, 'version'), 1) };
  }

  private async applyFailure(
    entry: AnyRecord,
    payload: ReportRequestPayload,
    settings: Awaited<ReturnType<SelectorSettingsService['get']>>,
  ): Promise<ReportResult> {
    const nowIso = this.now().toISOString();
    const now = this.now();
    const status = read(entry, 'status') as EntryStatus;
    const confidence = this.ewma(toNumber(read(entry, 'confidence'), 0.5), 0, settings.ewmaAlpha);
    const failStreak = toNumber(read(entry, 'failStreak')) + 1;

    const baseValues: Record<string, unknown> = {
      failCount: toNumber(read(entry, 'failCount')) + 1,
      failStreak,
      lastFailureAt: nowIso,
      lastUsedAt: nowIso,
      confidence,
      confidenceUpdatedAt: nowIso,
    };

    const version = await this.findVersionForFailure(entry, payload);
    let versionFailCount = 0;
    if (version) {
      versionFailCount = toNumber(read(version, 'failCount')) + 1;
      await this.repo('selectorVersions').update({
        filterByTk: read(version, 'id'),
        values: { failCount: versionFailCount },
      });
    }

    // Auto-rollback: the freshly healed selector keeps failing, and a previous
    // version has a positive track record -> fall back to last known good.
    if (version && versionFailCount >= settings.rollbackFailLimit) {
      const previous = await this.findRollbackTarget(entry);
      if (previous) {
        const nextVersion = toNumber(read(entry, 'version'), 1) + 1;
        await this.repo('selectorVersions').update({
          filterByTk: read(version, 'id'),
          values: { status: 'rolled_back', rolledBackAt: nowIso },
        });
        await this.repo('selectorVersions').update({
          filterByTk: read(previous, 'id'),
          values: { status: 'active' },
        });
        await this.repo('selectorEntries').update({
          filterByTk: read(entry, 'id'),
          values: {
            ...baseValues,
            currentSelector: read(previous, 'selector'),
            selectorType: read(previous, 'selectorType') ?? 'css',
            signature: read(previous, 'signatureAtCapture') ?? read(entry, 'signature'),
            status: 'probation',
            probationSuccessCount: 0,
            failStreak: 0,
            version: nextVersion,
            resolvedBy: 'rollback',
            lastResolvedAt: nowIso,
            confidence: Math.max(confidence, toNumber(read(previous, 'confidence'), 0.5)),
          },
        });
        return {
          recorded: true,
          entryStatus: 'probation',
          confidence,
          rolledBack: true,
          newSelector: read(previous, 'selector') as string | null,
          newSelectorType: (read(previous, 'selectorType') as SelectorType) ?? 'css',
          version: nextVersion,
        };
      }
    }

    let nextStatus: EntryStatus = status;
    if (status !== 'quarantined' && status !== 'disabled') {
      if (confidence <= settings.quarantineThreshold && failStreak >= settings.failStreakLimit) {
        nextStatus = 'quarantined';
        baseValues.circuitBrokenUntil = new Date(now.getTime() + settings.circuitBreakerCooldownMs).toISOString();
      } else if (failStreak >= settings.failStreakLimit) {
        nextStatus = 'degraded';
      }
    }
    baseValues.status = nextStatus;

    await this.repo('selectorEntries').update({
      filterByTk: read(entry, 'id'),
      values: baseValues,
    });

    return { recorded: true, entryStatus: nextStatus, confidence, version: toNumber(read(entry, 'version'), 1) };
  }

  // Attribute the outcome to the version matching the selector the client
  // actually used; fall back to the currently active version.
  private async bumpVersionCounter(
    entry: AnyRecord,
    payload: ReportRequestPayload,
    counter: 'successCount',
  ): Promise<void> {
    let version: AnyRecord | null = null;
    if (payload.selectorUsed) {
      version = await this.repo('selectorVersions').findOne({
        filter: { entryId: read(entry, 'id'), selector: payload.selectorUsed },
        sort: ['-createdAt'],
      });
    }
    if (!version) {
      version = await this.repo('selectorVersions').findOne({
        filter: { entryId: read(entry, 'id'), status: 'active' },
        sort: ['-createdAt'],
      });
    }
    if (!version) return;
    await this.repo('selectorVersions').update({
      filterByTk: read(version, 'id'),
      values: { [counter]: toNumber(read(version, counter)) + 1 },
    });
  }

  private async findVersionForFailure(entry: AnyRecord, payload: ReportRequestPayload): Promise<AnyRecord | null> {
    if (payload.selectorUsed) {
      const bySelector = await this.repo('selectorVersions').findOne({
        filter: { entryId: read(entry, 'id'), selector: payload.selectorUsed },
        sort: ['-createdAt'],
      });
      if (bySelector) return bySelector;
    }
    return this.repo('selectorVersions').findOne({
      filter: { entryId: read(entry, 'id'), status: 'active' },
      sort: ['-createdAt'],
    });
  }

  // The rollback target is the newest superseded version that proved itself
  // (at least one recorded success). A version that never worked is never a
  // safe fallback.
  private async findRollbackTarget(entry: AnyRecord): Promise<AnyRecord | null> {
    const candidates = await this.repo('selectorVersions').find({
      filter: { entryId: read(entry, 'id'), status: 'superseded' },
      sort: ['-createdAt'],
      limit: 10,
    });
    return candidates.find((candidate) => toNumber(read(candidate, 'successCount')) > 0) ?? null;
  }
}
