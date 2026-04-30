import { Context, Next } from '@nocobase/actions';
import { Repository } from '@nocobase/database';
import { assertDiagramAccess } from './access';

export async function loadXml(ctx: Context, next: Next) {
  const { filterByTk } = ctx.action.params;
  const { resourceName } = ctx.action;
  const repository = ctx.db.getRepository<any>(resourceName) as Repository;
  const model = await repository.findById(filterByTk);

  if (!model) {
    ctx.throw(404, 'Diagram not found');
  }

  assertDiagramAccess(ctx, model);

  ctx.body = model.get('xmlContent') || '';
  ctx.withoutDataWrapping = true;

  ctx.set({
    'Content-Type': 'application/xml; charset=UTF-8',
  });

  await next();
}
