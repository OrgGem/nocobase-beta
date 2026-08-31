import {
  UNHEALABLE_FAILURE_TYPES,
  type ElementSignature,
  type ResolveRequestPayload,
  type ResolveResponsePayload,
  type SelectorRef,
  type SelectorType,
} from '../../constants';
import { extractNeighborhood, parseDom, trimDomSnippet, validateSelector } from './dom-analyzer';
import { SelectorRegistryError } from './errors';
import { heuristicRepair } from './heuristic-repair';
import { computeElementKey, selectorFingerprint } from './key-service';
import { LLMResolver, type LLMResolveResult } from './llm-resolver';
import { captureSignature, selectorSignatureScore } from './signature-service';
import type { SelectorSettingsService } from './settings-service';
import { read, toIso, toNumber, type AnyRecord } from '../utils/record-helpers';

export type { AnyRecord };

export interface RepositoryLike {
  findOne(options?: {
    filter?: Record<string, unknown>;
    filterByTk?: unknown;
    sort?: string[];
  }): Promise<AnyRecord | null>;
  find(options?: { filter?: Record<string, unknown>; sort?: string[]; limit?: number }): Promise<AnyRecord[]>;
  create(options: { values: Record<string, unknown> }): Promise<AnyRecord>;
  update(options: {
    filterByTk?: unknown;
    filter?: Record<string, unknown>;
    values: Record<string, unknown>;
  }): Promise<unknown>;
  destroy(options?: { filter?: Record<string, unknown> }): Promise<number>;
  count(options?: { filter?: Record<string, unknown> }): Promise<number>;
}

export interface DatabaseLike {
  getRepository(name: string): RepositoryLike;
}

export interface ResolveMeta {
  clientIp?: string;
  // Admin revalidate runs force the dry-run path regardless of the app flag.
  forceDryRun?: boolean;
}

export interface ResolvePipelineOptions {
  database: DatabaseLike;
  settings: SelectorSettingsService;
  createLLMResolver?: (config: { llmService: string; model: string }) => LLMResolver | null;
  now?: () => Date;
}

interface ChosenSelector {
  selector: string;
  selectorType: SelectorType;
  source: 'heuristic' | 'llm';
  reason: string;
  confidence: number;
  llmModel?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
}

// Candidates whose signature resemblance falls below this are treated as the
// wrong element and rejected, even when they match exactly one node.
const SIGNATURE_REJECT_THRESHOLD = 0.3;
const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000;
const MAX_FALLBACKS = 3;
const LOG_SNIPPET_MAX = 2000;

interface InflightEntry {
  promise: Promise<ResolveResponsePayload>;
  timer: NodeJS.Timeout;
}

export class ResolvePipeline {
  private readonly inflight = new Map<string, InflightEntry>();
  private readonly now: () => Date;

  constructor(private readonly options: ResolvePipelineOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private repo(name: string): RepositoryLike {
    return this.options.database.getRepository(name);
  }

  async resolve(payload: ResolveRequestPayload, meta: ResolveMeta = {}): Promise<ResolveResponsePayload> {
    const settings = await this.options.settings.get();
    if (!settings.enabled) {
      throw new SelectorRegistryError('REGISTRY_DISABLED', 503, 'The selector registry is disabled.');
    }
    if (!payload.app || !payload.app.trim()) {
      throw new SelectorRegistryError('MISSING_APP', 400, 'The "app" field is required.');
    }

    const app = await this.repo('selectorApps').findOne({ filter: { name: payload.app.trim() } });
    if (!app) {
      throw new SelectorRegistryError('APP_NOT_FOUND', 404, `Selector app "${payload.app}" is not registered.`);
    }
    if (read(app, 'status') !== 'active') {
      throw new SelectorRegistryError('APP_INACTIVE', 403, `Selector app "${payload.app}" is not active.`);
    }
    const appId = read(app, 'id');
    const dryRun = Boolean(read(app, 'dryRun'));

    let elementKey = payload.elementKey?.trim();
    if (!elementKey) {
      if (!payload.logicalId?.trim()) {
        throw new SelectorRegistryError('ELEMENT_KEY_REQUIRED', 400, 'Provide "elementKey" or "logicalId".');
      }
      elementKey = computeElementKey({
        app: payload.app,
        pageUrlPattern: payload.pageUrlPattern ?? payload.pageUrl,
        logicalId: payload.logicalId,
      });
    }

    const entry = await this.repo('selectorEntries').findOne({ filter: { appId, elementKey } });
    const startedAt = this.now();
    const selector = payload.selector?.trim() || null;
    const status = (read(entry, 'status') as string | undefined) ?? null;
    const currentSelector = (read(entry, 'currentSelector') as string | undefined) ?? null;

    if (status === 'disabled') {
      const response = this.missResponse(elementKey, entry, false);
      await this.writeLog({ appId, elementKey, entry, payload, path: 'skipped', meta, startedAt, response });
      return response;
    }

    // Dirty evidence: the page itself was broken, so learning from it would
    // poison the registry. Serve the last known good selector and stop.
    if (payload.failureType && UNHEALABLE_FAILURE_TYPES.includes(payload.failureType)) {
      await this.touchEntry(entry);
      const response =
        entry && currentSelector
          ? this.entryResponse(elementKey, entry, 'skipped', false, settings)
          : this.missResponse(elementKey, entry, false);
      await this.writeLog({ appId, elementKey, entry, payload, path: 'skipped', meta, startedAt, response });
      return response;
    }

    const healthy = Boolean(entry && currentSelector && (status === 'active' || status === 'probation'));

    if (!payload.failureType) {
      if (entry && healthy && currentSelector) {
        const fingerprint = selector ? selectorFingerprint(selector) : null;
        const exactMatch = fingerprint !== null && fingerprint === selectorFingerprint(currentSelector);
        if (exactMatch && !this.isStale(entry, settings.entryTtlMs)) {
          await this.touchEntry(entry);
          const response = this.entryResponse(elementKey, entry, 'cache_hit', false, settings);
          await this.writeLog({ appId, elementKey, entry, payload, path: 'cache_hit', meta, startedAt, response });
          return response;
        }
        await this.touchEntry(entry);
        const response = this.entryResponse(elementKey, entry, 'registry', false, settings);
        await this.writeLog({ appId, elementKey, entry, payload, path: 'registry', meta, startedAt, response });
        return response;
      }

      // Bootstrap: first sight of this element with a working selector.
      if (selector) {
        const created = await this.bootstrapEntry({ appId, elementKey, payload, selector });
        const response = this.entryResponse(elementKey, created, 'registry', false, settings);
        await this.writeLog({
          appId,
          elementKey,
          entry: created,
          payload,
          path: 'registry',
          meta,
          startedAt,
          response,
        });
        return response;
      }

      const response = this.missResponse(elementKey, entry, false);
      await this.writeLog({ appId, elementKey, entry, payload, path: 'miss', meta, startedAt, response });
      return response;
    }

    // A healable failure was reported: enter the healing path with dedup so a
    // fleet of failing bots triggers a single repair attempt.
    const dedupeKey = `${appId}:${elementKey}`;
    const running = this.inflight.get(dedupeKey);
    if (running) {
      return running.promise;
    }
    const promise = this.heal({
      appId,
      elementKey,
      app,
      entry,
      payload,
      meta,
      startedAt,
      dryRun: dryRun || Boolean(meta.forceDryRun),
      settings,
    });
    const timer = setTimeout(() => {
      this.inflight.delete(dedupeKey);
    }, 30_000);
    this.inflight.set(dedupeKey, { promise, timer });
    promise
      .finally(() => {
        clearTimeout(timer);
        this.inflight.delete(dedupeKey);
      })
      .catch(() => {
        // Unhandled rejection is expected: the caller awaits the same promise.
      });
    return promise;
  }

  private isStale(entry: AnyRecord, entryTtlMs: number): boolean {
    if (!entryTtlMs || entryTtlMs <= 0) return false;
    const lastSuccess = read(entry, 'lastSuccessAt');
    if (!lastSuccess) return false;
    return this.now().getTime() - new Date(lastSuccess as string).getTime() > entryTtlMs;
  }

  private async touchEntry(entry: AnyRecord | null): Promise<void> {
    if (!entry) return;
    await this.repo('selectorEntries').update({
      filterByTk: read(entry, 'id'),
      values: { hitCount: toNumber(read(entry, 'hitCount')) + 1, lastUsedAt: toIso(this.now()) },
    });
  }

  private fallbacksOf(entry: AnyRecord | null): SelectorRef[] {
    const raw = read(entry, 'fallbackSelectors');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is SelectorRef =>
        Boolean(item && typeof item === 'object' && (item as SelectorRef).selector),
      )
      .slice(0, MAX_FALLBACKS);
  }

  private entryResponse(
    elementKey: string,
    entry: AnyRecord,
    source: ResolveResponsePayload['source'],
    healTriggered: boolean,
    settings: { entryTtlMs: number },
  ): ResolveResponsePayload {
    const signature = read(entry, 'signature') as ElementSignature | null;
    return {
      elementKey,
      selector: (read(entry, 'currentSelector') as string | null) ?? null,
      selectorType: (read(entry, 'selectorType') as SelectorType) ?? 'css',
      fallbacks: this.fallbacksOf(entry),
      signature: signature ?? undefined,
      confidence: toNumber(read(entry, 'confidence'), 0.5),
      source,
      version: toNumber(read(entry, 'version'), 1),
      status: (read(entry, 'status') as ResolveResponsePayload['status']) ?? 'probation',
      healTriggered,
      ttlMs: settings.entryTtlMs > 0 ? settings.entryTtlMs : undefined,
    };
  }

  private missResponse(elementKey: string, entry: AnyRecord | null, healTriggered: boolean): ResolveResponsePayload {
    return {
      elementKey,
      selector: entry ? (read(entry, 'currentSelector') as string | null) ?? null : null,
      selectorType: entry ? (read(entry, 'selectorType') as SelectorType) ?? 'css' : 'css',
      fallbacks: this.fallbacksOf(entry),
      confidence: entry ? toNumber(read(entry, 'confidence'), 0) : 0,
      source: 'miss',
      version: entry ? toNumber(read(entry, 'version'), 0) : 0,
      status: entry ? (read(entry, 'status') as ResolveResponsePayload['status']) ?? 'probation' : 'probation',
      healTriggered,
    };
  }

  private async bootstrapEntry(input: {
    appId: unknown;
    elementKey: string;
    payload: ResolveRequestPayload;
    selector: string;
  }): Promise<AnyRecord> {
    const nowIso = toIso(this.now());
    const entry = await this.repo('selectorEntries').create({
      values: {
        appId: input.appId,
        elementKey: input.elementKey,
        name: input.payload.name ?? null,
        pageUrlPattern: input.payload.pageUrlPattern ?? input.payload.pageUrl ?? null,
        currentSelector: input.selector,
        selectorType: input.payload.selectorType ?? 'css',
        fallbackSelectors: [],
        signature: null,
        status: 'probation',
        pinned: false,
        confidence: 0.5,
        confidenceUpdatedAt: nowIso,
        hitCount: 1,
        successCount: 0,
        failCount: 0,
        failStreak: 0,
        probationSuccessCount: 0,
        version: 1,
        resolvedBy: 'registry',
        lastUsedAt: nowIso,
      },
    });
    await this.repo('selectorVersions').create({
      values: {
        entryId: read(entry, 'id'),
        selector: input.selector,
        selectorType: input.payload.selectorType ?? 'css',
        source: 'client',
        confidence: 0.5,
        reason: 'bootstrap registration from client',
        status: 'active',
      },
    });
    return entry;
  }

  private async heal(context: {
    appId: unknown;
    elementKey: string;
    app: AnyRecord;
    entry: AnyRecord | null;
    payload: ResolveRequestPayload;
    meta: ResolveMeta;
    startedAt: Date;
    dryRun: boolean;
    settings: Awaited<ReturnType<SelectorSettingsService['get']>>;
  }): Promise<ResolveResponsePayload> {
    const { appId, elementKey, entry, payload, meta, startedAt, dryRun, settings } = context;
    const now = this.now();
    // Admin revalidate is a what-if: it must never consume circuit-breaker
    // budget, degrade, or otherwise mutate live state.
    const preview = Boolean(meta.forceDryRun);

    if (entry && read(entry, 'pinned')) {
      if (!preview) {
        await this.touchEntry(entry);
      }
      const response = this.entryResponse(elementKey, entry, 'skipped', false, settings);
      await this.writeLog({ appId, elementKey, entry, payload, path: 'skipped', meta, startedAt, response });
      return response;
    }

    if (payload.idempotencyKey) {
      const cached = await this.findIdempotentResponse(appId, elementKey, payload.idempotencyKey);
      if (cached) {
        await this.writeLog({
          appId,
          elementKey,
          entry,
          payload,
          path: cached.source,
          meta,
          startedAt,
          response: cached,
        });
        return cached;
      }
    }

    // Circuit breaker: an entry that keeps failing to heal is quarantined for
    // a cooldown instead of burning LLM calls forever.
    let healAttempts = 0;
    if (entry) {
      const brokenUntil = read(entry, 'circuitBrokenUntil');
      if (brokenUntil && new Date(brokenUntil as string).getTime() > now.getTime()) {
        const response = this.missResponse(elementKey, entry, true);
        await this.writeLog({ appId, elementKey, entry, payload, path: 'miss', meta, startedAt, response });
        return response;
      }
      const windowStartedAt = read(entry, 'healWindowStartedAt');
      healAttempts = toNumber(read(entry, 'healAttempts'));
      if (
        !windowStartedAt ||
        now.getTime() - new Date(windowStartedAt as string).getTime() > settings.circuitBreakerWindowMs
      ) {
        healAttempts = 0;
      }
      if (healAttempts >= settings.circuitBreakerMaxHeals) {
        if (!preview) {
          await this.repo('selectorEntries').update({
            filterByTk: read(entry, 'id'),
            values: {
              circuitBrokenUntil: toIso(new Date(now.getTime() + settings.circuitBreakerCooldownMs)),
              status: 'quarantined',
              healAttempts,
              healWindowStartedAt: toIso(now),
            },
          });
        }
        const response = this.missResponse(elementKey, entry, true);
        await this.writeLog({ appId, elementKey, entry, payload, path: 'miss', meta, startedAt, response });
        return response;
      }
      healAttempts += 1;
      if (!preview) {
        await this.repo('selectorEntries').update({
          filterByTk: read(entry, 'id'),
          values: { healAttempts, healWindowStartedAt: toIso(now) },
        });
      }
    }

    const failedSelector = payload.selector?.trim() ?? '';
    const selectorType = payload.selectorType ?? 'css';
    const domSnippet = payload.domSnippet ? trimDomSnippet(payload.domSnippet, settings.domSnippetMaxChars) : null;
    const storedSignature = (read(entry, 'signature') as ElementSignature | null) ?? null;

    let chosen: ChosenSelector | null = null;

    if (domSnippet) {
      const repairs = heuristicRepair({
        failedSelector,
        selectorType,
        domSnippet,
        candidates: payload.candidates,
        signature: storedSignature,
        triedSelectors: payload.triedSelectors,
      });
      for (const candidate of repairs) {
        if (
          storedSignature &&
          candidate.selectorType === 'css' &&
          candidate.signatureScore < SIGNATURE_REJECT_THRESHOLD
        ) {
          continue;
        }
        chosen = {
          selector: candidate.selector,
          selectorType: candidate.selectorType,
          source: 'heuristic',
          reason: candidate.reason,
          confidence: candidate.unique ? 0.7 : 0.45,
        };
        break;
      }
    }

    if (!chosen && domSnippet && settings.llmService && settings.llmModel && this.options.createLLMResolver) {
      chosen = await this.resolveWithLLM({
        domSnippet,
        failedSelector,
        selectorType,
        payload,
        storedSignature,
        entry,
        settings,
      });
    }

    if (!chosen) {
      if (!preview && entry && statusOf(entry) !== 'quarantined' && statusOf(entry) !== 'disabled') {
        await this.repo('selectorEntries').update({
          filterByTk: read(entry, 'id'),
          values: { status: 'degraded', lastResolvedAt: toIso(now) },
        });
      }
      const response = this.missResponse(elementKey, entry, true);
      await this.writeLog({ appId, elementKey, entry, payload, path: 'miss', meta, startedAt, response });
      return response;
    }

    const newSignature = domSnippet
      ? captureSignature(parseDom(domSnippet), chosen.selector, chosen.selectorType)
      : null;

    if (dryRun) {
      const base =
        entry && read(entry, 'currentSelector')
          ? this.entryResponse(elementKey, entry, 'registry', true, settings)
          : this.missResponse(elementKey, entry, true);
      const response: ResolveResponsePayload = {
        ...base,
        dryRunCandidate: { selector: chosen.selector, selectorType: chosen.selectorType, source: chosen.source },
      };
      await this.writeLog({
        appId,
        elementKey,
        entry,
        payload,
        path: chosen.source,
        meta,
        startedAt,
        response,
        selectorAfter: chosen.selector,
      });
      return response;
    }

    const applied = await this.applyHeal({
      appId,
      elementKey,
      entry,
      payload,
      chosen,
      newSignature,
      storedSignature,
      healAttempts,
      now,
    });

    const response: ResolveResponsePayload = {
      elementKey,
      selector: chosen.selector,
      selectorType: chosen.selectorType,
      fallbacks: applied.fallbacks,
      signature: newSignature ?? storedSignature ?? undefined,
      confidence: chosen.confidence,
      source: chosen.source,
      version: applied.version,
      status: 'probation',
      healTriggered: true,
      ttlMs: settings.entryTtlMs > 0 ? settings.entryTtlMs : undefined,
    };
    await this.writeLog({
      appId,
      elementKey,
      entry: applied.entry,
      payload,
      path: chosen.source,
      meta,
      startedAt,
      response,
      selectorBefore: entry ? (read(entry, 'currentSelector') as string | null) ?? null : null,
      selectorAfter: chosen.selector,
    });
    return response;
  }

  private async resolveWithLLM(context: {
    domSnippet: string;
    failedSelector: string;
    selectorType: SelectorType;
    payload: ResolveRequestPayload;
    storedSignature: ElementSignature | null;
    entry: AnyRecord | null;
    settings: Awaited<ReturnType<SelectorSettingsService['get']>>;
  }): Promise<ChosenSelector | null> {
    const { domSnippet, failedSelector, selectorType, payload, storedSignature, entry, settings } = context;
    const resolver = this.options.createLLMResolver?.({
      llmService: settings.llmService as string,
      model: settings.llmModel as string,
    });
    if (!resolver) return null;

    const startedAt = this.now();
    let result: LLMResolveResult;
    try {
      result = await resolver.resolve({
        failedSelector,
        selectorType,
        failureType: payload.failureType,
        errorMessage: payload.errorMessage,
        domSnippet: extractNeighborhood(domSnippet, failedSelector, selectorType, settings.domSnippetMaxChars),
        candidates: payload.candidates,
        history: await this.versionHistory(entry),
      });
    } catch {
      return null;
    }
    const latencyMs = this.now().getTime() - startedAt.getTime();

    const dom = parseDom(domSnippet);
    const tried = new Set((payload.triedSelectors ?? []).map((selector) => selector.trim()));
    let best: ChosenSelector | null = null;
    let bestScore = -1;
    for (const candidate of result.candidates) {
      if (tried.has(candidate.selector.trim())) continue;
      const validation = validateSelector(dom, candidate.selector, candidate.selectorType);
      if (candidate.selectorType === 'css' && (!validation.validatable || !validation.unique)) continue;
      const signatureScore = selectorSignatureScore(dom, candidate.selector, candidate.selectorType, storedSignature);
      if (storedSignature && candidate.selectorType === 'css' && signatureScore < SIGNATURE_REJECT_THRESHOLD) continue;
      const combined = signatureScore * 0.6 + candidate.confidence * 0.4;
      if (combined > bestScore) {
        bestScore = combined;
        best = {
          selector: candidate.selector,
          selectorType: candidate.selectorType,
          source: 'llm',
          reason: candidate.reasoning || 'llm proposal',
          confidence: Math.max(0.4, Math.min(0.65, candidate.confidence)),
          llmModel: result.model,
          promptTokens: result.usage?.promptTokens,
          completionTokens: result.usage?.completionTokens,
          latencyMs,
        };
      }
    }
    return best;
  }

  private async versionHistory(
    entry: AnyRecord | null,
  ): Promise<{ selector: string; selectorType: SelectorType; status: string; createdAt?: string }[]> {
    if (!entry) return [];
    const rows = await this.repo('selectorVersions').find({
      filter: { entryId: read(entry, 'id') },
      sort: ['createdAt'],
      limit: 5,
    });
    return rows.map((row) => ({
      selector: String(read(row, 'selector') ?? ''),
      selectorType: (read(row, 'selectorType') as SelectorType) ?? 'css',
      status: String(read(row, 'status') ?? ''),
      createdAt: read(row, 'createdAt') as string | undefined,
    }));
  }

  private async applyHeal(context: {
    appId: unknown;
    elementKey: string;
    entry: AnyRecord | null;
    payload: ResolveRequestPayload;
    chosen: ChosenSelector;
    newSignature: ElementSignature | null;
    storedSignature: ElementSignature | null;
    healAttempts: number;
    now: Date;
  }): Promise<{ entry: AnyRecord; version: number; fallbacks: SelectorRef[] }> {
    const { appId, elementKey, entry, payload, chosen, newSignature, storedSignature, healAttempts, now } = context;
    const nowIso = toIso(now);

    if (!entry) {
      const created = await this.repo('selectorEntries').create({
        values: {
          appId,
          elementKey,
          name: payload.name ?? null,
          pageUrlPattern: payload.pageUrlPattern ?? payload.pageUrl ?? null,
          currentSelector: chosen.selector,
          selectorType: chosen.selectorType,
          fallbackSelectors: [],
          signature: newSignature,
          status: 'probation',
          pinned: false,
          confidence: chosen.confidence,
          confidenceUpdatedAt: nowIso,
          hitCount: 1,
          successCount: 0,
          failCount: 0,
          failStreak: 0,
          probationSuccessCount: 0,
          version: 1,
          resolvedBy: chosen.source,
          lastUsedAt: nowIso,
          lastResolvedAt: nowIso,
          healAttempts,
          healWindowStartedAt: nowIso,
        },
      });
      await this.repo('selectorVersions').create({
        values: this.versionValues(created, chosen, newSignature),
      });
      return { entry: created, version: 1, fallbacks: [] };
    }

    const previousSelector = (read(entry, 'currentSelector') as string | null) ?? null;
    const previousType = (read(entry, 'selectorType') as SelectorType) ?? 'css';
    const fallbacks: SelectorRef[] = [
      ...(previousSelector && previousSelector !== chosen.selector
        ? [{ selector: previousSelector, selectorType: previousType }]
        : []),
      ...this.fallbacksOf(entry).filter((fallback) => fallback.selector !== chosen.selector),
    ].slice(0, MAX_FALLBACKS);
    const version = toNumber(read(entry, 'version'), 1) + 1;

    await this.repo('selectorEntries').update({
      filterByTk: read(entry, 'id'),
      values: {
        currentSelector: chosen.selector,
        selectorType: chosen.selectorType,
        fallbackSelectors: fallbacks,
        signature: newSignature ?? storedSignature,
        status: 'probation',
        probationSuccessCount: 0,
        failStreak: 0,
        confidence: chosen.confidence,
        confidenceUpdatedAt: nowIso,
        version,
        resolvedBy: chosen.source,
        lastResolvedAt: nowIso,
        name: read(entry, 'name') ?? payload.name ?? null,
        pageUrlPattern: read(entry, 'pageUrlPattern') ?? payload.pageUrlPattern ?? payload.pageUrl ?? null,
      },
    });
    await this.repo('selectorVersions').update({
      filter: { entryId: read(entry, 'id'), status: 'active' },
      values: { status: 'superseded' },
    });
    await this.repo('selectorVersions').create({
      values: this.versionValues(entry, chosen, newSignature),
    });
    return { entry, version, fallbacks };
  }

  private versionValues(entry: AnyRecord, chosen: ChosenSelector, signature: ElementSignature | null) {
    return {
      entryId: read(entry, 'id'),
      selector: chosen.selector,
      selectorType: chosen.selectorType,
      source: chosen.source,
      confidence: chosen.confidence,
      reason: chosen.reason,
      signatureAtCapture: signature,
      llmModel: chosen.llmModel ?? null,
      promptTokens: chosen.promptTokens ?? null,
      completionTokens: chosen.completionTokens ?? null,
      latencyMs: chosen.latencyMs ?? null,
      status: 'active',
    };
  }

  private async findIdempotentResponse(
    appId: unknown,
    elementKey: string,
    idempotencyKey: string,
  ): Promise<ResolveResponsePayload | null> {
    const since = toIso(new Date(this.now().getTime() - IDEMPOTENCY_WINDOW_MS));
    const log = await this.repo('selectorResolveLogs').findOne({
      filter: { appId, elementKey, idempotencyKey, createdAt: { $gt: since } },
      sort: ['-createdAt'],
    });
    if (!log) return null;
    const payload = read(log, 'responsePayload');
    return payload && typeof payload === 'object' ? (payload as ResolveResponsePayload) : null;
  }

  private async writeLog(context: {
    appId: unknown;
    elementKey: string;
    entry: AnyRecord | null;
    payload: ResolveRequestPayload;
    path: ResolveResponsePayload['source'];
    meta: ResolveMeta;
    startedAt: Date;
    response: ResolveResponsePayload;
    selectorBefore?: string | null;
    selectorAfter?: string | null;
  }): Promise<void> {
    const { appId, elementKey, entry, payload, path, meta, startedAt, response } = context;
    const snippet = payload.domSnippet ? payload.domSnippet.slice(0, LOG_SNIPPET_MAX) : null;
    await this.repo('selectorResolveLogs').create({
      values: {
        entryId: entry ? read(entry, 'id') : null,
        appId,
        elementKey,
        path,
        failureType: payload.failureType ?? null,
        idempotencyKey: payload.idempotencyKey ?? null,
        requestPayload: {
          app: payload.app,
          selector: payload.selector ?? null,
          selectorType: payload.selectorType ?? null,
          failureType: payload.failureType ?? null,
          errorMessage: payload.errorMessage ?? null,
          domSnippet: snippet,
          candidateCount: payload.candidates?.length ?? 0,
          agentId: payload.agentId ?? null,
        },
        responsePayload: response,
        selectorBefore: context.selectorBefore ?? null,
        selectorAfter: context.selectorAfter ?? null,
        durationMs: this.now().getTime() - startedAt.getTime(),
        agentId: payload.agentId ?? null,
        clientIp: meta.clientIp ?? null,
      },
    });
  }
}

const statusOf = (entry: AnyRecord): string => String(read(entry, 'status') ?? '');
