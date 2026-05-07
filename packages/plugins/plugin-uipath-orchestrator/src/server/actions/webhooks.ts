/**
 * Webhook receiver action
 *
 * Receives UiPath Orchestrator webhooks, verifies HMAC signature,
 * stores raw event, and triggers async processing.
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { UiPathWebhookVerifier } from '../services/UiPathWebhookVerifier';
import { handleError } from './shared';

export function createWebhookActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    /**
     * POST /uipathWebhooks:receive?instanceId=X
     *
     * UiPath sends webhook with:
     * - Header: X-UiPath-Signature (HMAC-SHA256)
     * - Body: JSON with Type, EventId, Timestamp, TenantId, FolderId, + entity data
     */
    receive: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const signature = ctx.get('X-UiPath-Signature') || ctx.get('x-uipath-signature');

        // Get instance webhook secret
        const instRepo = plugin.db.getRepository('uipathInstances');
        const instance = await instRepo.findOne({ filter: { id: Number(instanceId) } });

        if (!instance) {
          ctx.status = 404;
          ctx.body = { error: 'Instance not found' };
          await next();
          return;
        }

        const secret = instance.get('webhookSecret') as string;

        // Verify HMAC if secret is configured
        if (secret) {
          const rawBody = JSON.stringify(ctx.request.body);
          if (!UiPathWebhookVerifier.verify(secret, signature || '', rawBody)) {
            ctx.status = 401;
            ctx.body = { error: 'Invalid signature' };
            await next();
            return;
          }
        }

        const payload = ctx.request.body as any;
        const eventType = UiPathWebhookVerifier.parseEventType(payload);

        // Store raw event
        const eventRepo = plugin.db.getRepository('uipathWebhookEvents');
        await eventRepo.create({
          values: {
            instanceId: Number(instanceId),
            eventType,
            eventId: payload.EventId || null,
            tenantId: payload.TenantId || null,
            folderId: payload.FolderId || null,
            payload,
            status: 'pending',
          },
        });

        // Trigger cache refresh for the affected domain
        plugin.onWebhookEvent(Number(instanceId), eventType, payload);

        ctx.body = { received: true, eventType };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
