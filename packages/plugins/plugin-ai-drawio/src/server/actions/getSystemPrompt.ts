import { Context, Next } from '@nocobase/actions';
import { DRAWIO_SYSTEM_PROMPT_FULL } from '../lib/system-prompt';

export async function getSystemPrompt(ctx: Context, next: Next) {
  ctx.body = DRAWIO_SYSTEM_PROMPT_FULL;
  ctx.withoutDataWrapping = true;
  ctx.set({ 'Content-Type': 'text/plain; charset=UTF-8' });
  await next();
}
