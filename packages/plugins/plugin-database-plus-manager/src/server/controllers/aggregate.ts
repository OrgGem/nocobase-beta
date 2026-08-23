import { readParam } from '../utils/params';

export async function aggregate(ctx, next) {
  const params = (ctx.action?.params?.values ?? ctx.action?.params ?? {}) as Record<string, unknown>;
  const measures = params.measures;
  const dimensions = params.dimensions;

  if (!Array.isArray(measures) && !Array.isArray(dimensions)) {
    ctx.throw(400, 'Aggregate requires at least one measure or dimension');
  }

  const collection = readParam<string>(ctx, 'collection');
  if (!collection) ctx.throw(400, 'A collection name is required');
  const repository = ctx.db.getRepository(collection);

  const query: Record<string, unknown> = { context: ctx };
  if (Array.isArray(measures)) query.measures = measures;
  if (Array.isArray(dimensions)) query.dimensions = dimensions;
  for (const key of ['filter', 'having', 'orders', 'limit', 'offset', 'timezone']) {
    if (params[key] !== undefined) query[key] = params[key];
  }
  query.timezone = query.timezone ?? ctx.get?.('x-timezone');

  ctx.body = await repository.query(query);
  await next();
}
