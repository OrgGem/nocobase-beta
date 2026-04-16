import { Context, Next } from '@nocobase/actions';
import { Repository } from '@nocobase/database';

export async function getHtml(ctx: Context, next: Next) {
  const { filterByTk } = ctx.action.params;
  const { resourceName } = ctx.action;
  const repository = ctx.db.getRepository<any>(resourceName) as Repository;
  const model = await repository.findById(filterByTk);

  if (!model) {
    ctx.throw(404, 'User Guide not found');
  }

  if (model.get('status') !== 'completed') {
    ctx.throw(400, 'User Guide is not ready yet');
  }

  ctx.body = model.get('generatedHtml') || '';
  ctx.withoutDataWrapping = true;

  ctx.set({
    'Content-Type': 'text/html; charset=UTF-8',
  });

  await next();
}
