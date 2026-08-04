import type { Context } from '@nocobase/actions';
import type { Plugin } from '@nocobase/server';
import { LoopRunRepository } from '../services/LoopRunRepository';
import { getRunEventBus } from '../services/RunEventBus';
import { requestActor, throwResourceError } from './resource-helpers';

const POLL_INTERVAL_MS = 1500;

function eventId(event: unknown) {
  if (!event || typeof event !== 'object') return 0;
  const id = Number((event as Record<string, unknown>).id);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function plainEvent(event: unknown) {
  if (!event || typeof event !== 'object') return event;
  const record = event as { toJSON?: () => unknown };
  return typeof record.toJSON === 'function' ? record.toJSON() : event;
}

function writeEvent(ctx: Context, event: unknown) {
  const id = eventId(event);
  if (id > 0) ctx.res.write(`id: ${id}\n`);
  ctx.res.write(`data: ${JSON.stringify(plainEvent(event))}\n\n`);
}

export function registerAgentLoopEventsStreamResource(plugin: Plugin) {
  const repository = new LoopRunRepository(plugin.db);

  plugin.app.resource({
    name: 'agentLoopEventsStream',
    actions: {
      async stream(ctx, next) {
        try {
          const actor = requestActor(ctx);
          const runId = Number(ctx.action.params.runId || ctx.action.params.filterByTk);
          if (!Number.isSafeInteger(runId) || runId <= 0) ctx.throw(400, 'runId is required');
          await repository.requireOwnedRun(runId, actor.userId, actor.isAdmin);

          ctx.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          ctx.status = 200;

          let closed = false;
          let lastEventId = Number(ctx.get('Last-Event-ID')) || 0;
          const close = () => {
            closed = true;
          };
          const send = (event: unknown) => {
            const id = eventId(event);
            if (closed || ctx.res.destroyed || ctx.res.writableEnded || (id > 0 && id <= lastEventId)) return;
            writeEvent(ctx, event);
            if (id > 0) lastEventId = id;
          };

          ctx.req.once('aborted', close);
          ctx.res.once('close', close);
          const unsubscribe = getRunEventBus().subscribe(runId, send);

          try {
            const initial = await ctx.db.getRepository('agentLoopEvents').find({
              filter: lastEventId > 0 ? { runId, id: { $gt: lastEventId } } : { runId },
              sort: ['id'],
              pageSize: 1000,
            });
            for (const event of initial) send(event);

            await new Promise<void>((resolve) => {
              const poll = async () => {
                if (closed || ctx.res.destroyed || ctx.res.writableEnded) {
                  resolve();
                  return;
                }
                try {
                  const events = await ctx.db.getRepository('agentLoopEvents').find({
                    filter: { runId, id: { $gt: lastEventId } },
                    sort: ['id'],
                    pageSize: 1000,
                  });
                  for (const event of events) send(event);
                } catch (error) {
                  ctx.log.error('[AgentOrchestrator] Failed to poll loop events', error);
                }
                if (closed || ctx.res.destroyed || ctx.res.writableEnded) resolve();
                else setTimeout(poll, POLL_INTERVAL_MS);
              };
              setTimeout(poll, POLL_INTERVAL_MS);
            });
          } finally {
            unsubscribe();
            ctx.req.off('aborted', close);
            ctx.res.off('close', close);
            if (!ctx.res.destroyed && !ctx.res.writableEnded) ctx.res.end();
          }
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },
    },
  });
}
