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

  if (model.get?.('mode') === 'readonly') {
    ctx.body = { success: true, readonly: true };
    await next();
    return;
  }

  const body = (ctx.request as any).body || {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    ctx.throw(400, 'Request body must be an object');
  }
  const { xml, thumbnailSvg } = body as { xml?: unknown; thumbnailSvg?: unknown };

  if (typeof xml !== 'string') {
    ctx.throw(400, 'xml is required');
  }

  if (xml.length > 5 * 1024 * 1024) {
    ctx.throw(400, 'xml size exceeds the 5MB limit');
  }

  const updateValues: Record<string, any> = {
    xmlContent: xml,
    updatedById: ctx.state?.currentUser?.id,
  };

  if (typeof thumbnailSvg === 'string') {
    if (thumbnailSvg.length > 1 * 1024 * 1024) {
      ctx.throw(400, 'thumbnailSvg size exceeds the 1MB limit');
    }
    // Sanitize thumbnailSvg to prevent XSS
    updateValues.thumbnailSvg = thumbnailSvg.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  }

  await repository.update({
    filterByTk,
    values: updateValues,
  });

  ctx.body = { success: true };
  await next();
}
