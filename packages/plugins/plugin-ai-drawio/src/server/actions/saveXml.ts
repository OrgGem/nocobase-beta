import { Context, Next } from '@nocobase/actions';
import { Repository } from '@nocobase/database';
import { assertDiagramAccess } from './access';

export async function saveXml(ctx: Context, next: Next) {
  const { filterByTk } = ctx.action.params;
  const { resourceName } = ctx.action;
  const repository = ctx.db.getRepository<any>(resourceName) as Repository;
  const model = await repository.findById(filterByTk);

  if (!model) {
    ctx.throw(404, 'Diagram not found');
  }

  assertDiagramAccess(ctx, model);

  const body = (ctx.request as any).body || {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    ctx.throw(400, 'Request body must be an object');
  }
  const { xml, thumbnailSvg } = body as { xml?: unknown; thumbnailSvg?: unknown };

  if (typeof xml !== 'string') {
    ctx.throw(400, 'xml is required');
  }

  const updateValues: Record<string, any> = {
    xmlContent: xml,
    updatedById: ctx.state?.currentUser?.id,
  };

  if (typeof thumbnailSvg === 'string') {
    updateValues.thumbnailSvg = thumbnailSvg;
  }

  await repository.update({
    filterByTk,
    values: updateValues,
  });

  ctx.body = { success: true };
  await next();
}
