import type { AppObservabilityContract } from '../contracts';
import type { ObservabilitySettings, SettingsRepository } from '../repositories/settings-repository';
import type { QueryService } from '../services/query-service';

interface ResourceContext {
  body: unknown;
  action: {
    params?: { values?: Record<string, unknown>; from?: string; to?: string; page?: number; pageSize?: number };
  };
}
type Next = () => Promise<unknown>;
interface ResourceManagerLike {
  define(options: { name: string; actions: Record<string, (ctx: ResourceContext, next: Next) => Promise<void>> }): void;
}
interface AclLike {
  registerSnippet(options: { name: string; actions: string[] }): void;
}
export function registerAppObservabilityResources(
  app: { resourceManager: ResourceManagerLike; acl: AclLike },
  services: {
    query: QueryService;
    settings: SettingsRepository;
    contract: AppObservabilityContract;
    onSettingsUpdated?: (settings: ObservabilitySettings) => Promise<void>;
  },
): void {
  app.resourceManager.define({
    name: 'appObservability',
    actions: {
      overview: action(async () => services.query.overview()),
      nodes: action(async () => services.query.nodes()),
      services: action(async () => services.query.services()),
      history: action(async (ctx) => services.query.history(ctx.action.params ?? {})),
      capacity: action(async () => services.contract.getCapacityAssessment()),
      settings: action(async () => services.settings.get()),
      updateSettings: action(async (ctx) => {
        const settings = await services.settings.update(
          (ctx.action.params?.values ?? {}) as Partial<ObservabilitySettings>,
        );
        await services.onSettingsUpdated?.(settings);
        return settings;
      }),
    },
  });
  app.acl.registerSnippet({ name: 'pm.plugin-app-observability', actions: ['appObservability:*'] });
}
function action(handler: (ctx: ResourceContext) => Promise<unknown>) {
  return async (ctx: ResourceContext, next: Next) => {
    ctx.body = await handler(ctx);
    await next();
  };
}
