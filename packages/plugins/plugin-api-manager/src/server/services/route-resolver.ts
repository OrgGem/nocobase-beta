import type { Database, Model } from '@nocobase/database';
import { ERROR_CODES, type RouteDirection } from '../../constants';
import { ApimError } from './errors';

/**
 * Resolves the gateway route for an incoming request. Throws:
 * - 404 APIM_ROUTE_NOT_FOUND when no matching route exists or it is disabled
 * - 405 APIM_METHOD_NOT_ALLOWED when the route exists but the method differs
 */
export async function resolveGatewayRoute(
  db: Database,
  direction: RouteDirection,
  pathOrName: string,
  method: string,
): Promise<Model> {
  const repo = db.getRepository('apiRoutes');
  const filter =
    direction === 'inbound'
      ? { direction: 'inbound', inboundPath: pathOrName }
      : { direction: 'outbound', name: pathOrName };
  const route = await repo.findOne({ filter });
  if (!route || !route.get('enabled')) {
    throw new ApimError(ERROR_CODES.ROUTE_NOT_FOUND, 'Route not found', 404);
  }
  if (String(route.get('method') ?? '').toUpperCase() !== method.toUpperCase()) {
    throw new ApimError(ERROR_CODES.METHOD_NOT_ALLOWED, 'Method not allowed for this route', 405);
  }
  return route;
}
