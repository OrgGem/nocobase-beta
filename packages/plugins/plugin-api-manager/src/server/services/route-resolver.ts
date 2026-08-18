import type { Database, Model } from '@nocobase/database';
import type { RouteDirection } from '../../constants';

export async function findRoute(
  db: Database,
  direction: RouteDirection,
  pathOrName: string,
  method: string,
): Promise<Model | null> {
  const repo = db.getRepository('apiRoutes');
  const normalizedMethod = method.toUpperCase();
  if (direction === 'inbound') {
    return repo.findOne({
      filter: {
        direction: 'inbound',
        inboundPath: pathOrName,
        method: normalizedMethod,
        enabled: true,
      },
    });
  }
  return repo.findOne({
    filter: {
      direction: 'outbound',
      name: pathOrName,
      method: normalizedMethod,
      enabled: true,
    },
  });
}
