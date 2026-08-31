import type {
  BulkLookupRequestPayload,
  ReportRequestPayload,
  ResolveRequestPayload,
  ResolveResponsePayload,
  SelectorRef,
} from '../../constants';
import { SelectorRegistryError } from '../services/errors';
import type { FeedbackService } from '../services/feedback-service';
import type { DatabaseLike, ResolvePipeline } from '../services/resolve-pipeline';
import { read, toNumber, type AnyRecord } from '../utils/record-helpers';

type ActionContext = {
  request: { body?: unknown };
  body?: unknown;
  status?: number;
  ip?: string;
  withoutDataWrapping?: boolean;
  get?(name: string): string;
};

export interface ClientActionsDeps {
  database: DatabaseLike;
  pipeline: ResolvePipeline;
  feedback: FeedbackService;
}

const bodyOf = (ctx: ActionContext): Record<string, unknown> =>
  ctx.request.body && typeof ctx.request.body === 'object' ? (ctx.request.body as Record<string, unknown>) : {};

export const sendError = (ctx: ActionContext, error: unknown): void => {
  // Keep the platform error shape `{ errors: [...] }` unwrapped in `data`.
  ctx.withoutDataWrapping = true;
  if (error instanceof SelectorRegistryError) {
    ctx.status = error.status;
    ctx.body = { errors: [{ code: error.code, message: error.message }] };
    return;
  }
  ctx.status = 500;
  ctx.body = { errors: [{ code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) }] };
};

const clientIpOf = (ctx: ActionContext): string | undefined =>
  ctx.ip || (typeof ctx.get === 'function' ? ctx.get('x-forwarded-for')?.split(',')[0]?.trim() : undefined);

export const createClientActions = (deps: ClientActionsDeps) => {
  const resolve = async (ctx: ActionContext) => {
    try {
      const payload = bodyOf(ctx) as unknown as ResolveRequestPayload;
      const response = await deps.pipeline.resolve(payload, { clientIp: clientIpOf(ctx) });
      ctx.body = response;
    } catch (error) {
      sendError(ctx, error);
    }
  };

  const report = async (ctx: ActionContext) => {
    try {
      const payload = bodyOf(ctx) as unknown as ReportRequestPayload;
      ctx.body = await deps.feedback.report(payload);
    } catch (error) {
      sendError(ctx, error);
    }
  };

  // Delta sync for client local caches: the client sends the versions it has,
  // the registry answers only with what changed. Entries are fetched in a
  // single batch query to avoid N sequential round-trips.
  const bulkLookup = async (ctx: ActionContext) => {
    try {
      const payload = bodyOf(ctx) as unknown as BulkLookupRequestPayload;
      if (!payload.app?.trim()) {
        throw new SelectorRegistryError('MISSING_APP', 400, 'The "app" field is required.');
      }
      if (!Array.isArray(payload.items)) {
        throw new SelectorRegistryError('MISSING_ITEMS', 400, 'The "items" array is required.');
      }
      const app = await deps.database.getRepository('selectorApps').findOne({
        filter: { name: payload.app.trim() },
      });
      if (!app) {
        throw new SelectorRegistryError('APP_NOT_FOUND', 404, `Selector app "${payload.app}" is not registered.`);
      }
      const appId = read(app, 'id');

      const items = payload.items.slice(0, 500).filter((item) => item?.elementKey);
      const keys = items.map((item) => item.elementKey.trim()).filter(Boolean);

      const entries = keys.length
        ? await deps.database.getRepository('selectorEntries').find({
            filter: { appId, elementKey: { $in: keys } },
          })
        : [];
      const byKey = new Map<string, AnyRecord>();
      for (const entry of entries) {
        const key = String(read(entry, 'elementKey') ?? '');
        if (key) byKey.set(key, entry);
      }

      const updates: (ResolveResponsePayload & { name?: string | null })[] = [];
      const unknown: string[] = [];
      let unchanged = 0;

      for (const item of items) {
        const entry = byKey.get(item.elementKey.trim());
        if (!entry || read(entry, 'status') === 'disabled') {
          unknown.push(item.elementKey);
          continue;
        }
        const version = toNumber(read(entry, 'version'));
        if (item.version !== undefined && Number(item.version) === version) {
          unchanged += 1;
          continue;
        }
        const rawFallbacks = read(entry, 'fallbackSelectors');
        const fallbacks: SelectorRef[] = Array.isArray(rawFallbacks)
          ? rawFallbacks.filter((fallback): fallback is SelectorRef => Boolean(fallback?.selector))
          : [];
        updates.push({
          elementKey: item.elementKey,
          selector: (read(entry, 'currentSelector') as string | null) ?? null,
          selectorType: (read(entry, 'selectorType') as ResolveResponsePayload['selectorType']) ?? 'css',
          fallbacks,
          signature: (read(entry, 'signature') as ResolveResponsePayload['signature']) ?? undefined,
          confidence: toNumber(read(entry, 'confidence'), 0.5),
          source: 'registry',
          version,
          status: (read(entry, 'status') as ResolveResponsePayload['status']) ?? 'probation',
          healTriggered: false,
          name: (read(entry, 'name') as string | null) ?? null,
        });
      }

      ctx.body = { app: payload.app, updates, unknown, unchanged };
    } catch (error) {
      sendError(ctx, error);
    }
  };

  return { resolve, report, bulkLookup };
};
