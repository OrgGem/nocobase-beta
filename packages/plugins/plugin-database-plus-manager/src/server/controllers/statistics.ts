import { getStats, getViews, listCollections } from '../utils/stats';
import { readParam } from '../utils/params';

export async function statistics(ctx, next) {
  const collectionName = readParam<string>(ctx, 'collection');

  if (collectionName) {
    const stats = await getStats(ctx.db, collectionName);

    let views: unknown[] = [];
    try {
      views = (await getViews(ctx.db)) ?? [];
    } catch {
      views = [];
    }

    ctx.body = { collection: stats, views };
  } else {
    const collections = await listCollections(ctx.db);
    ctx.body = { collections };
  }

  await next();
}
