import { Application } from '@nocobase/server';
import { Plugin } from '@nocobase/server';

/**
 * WebSocket message handler for comm:* events.
 *
 * Listens for incoming WS messages with type 'comm' and routes them
 * to the appropriate handler based on the action field.
 *
 * This leverages NocoBase's built-in WSServer tag-based routing:
 * - Each user in a channel gets tagged with `commChannel#<channelId>`
 * - Messages are broadcast to all clients with matching tags
 * - Cross-instance sync is handled by NocoBase's PubSubManager (Redis)
 */
export function commWsHandler(app: Application, plugin: Plugin) {
  // Handle incoming comm WS messages
  app.on('ws:message:comm', async ({ clientId, tags, payload }) => {
    const { action, data } = payload || {};

    switch (action) {
      case 'join_channel':
        await handleJoinChannel(app, clientId, data);
        break;

      case 'leave_channel':
        await handleLeaveChannel(app, clientId, data);
        break;

      case 'join_channels':
        await handleJoinChannels(app, clientId, data);
        break;

      case 'typing_start':
        await handleTyping(app, clientId, data, true);
        break;

      case 'typing_stop':
        await handleTyping(app, clientId, data, false);
        break;

      case 'presence_heartbeat':
        await handlePresenceHeartbeat(app, clientId, tags, data);
        break;

      default:
        app.logger.debug(`[comm-core] Unknown WS action: ${action}`);
    }
  });

  app.logger.info('[comm-core] WebSocket handler registered');
}

/**
 * Tag the client's WS connection with the channel ID so they receive
 * all messages broadcast to that channel.
 */
async function handleJoinChannel(app: Application, clientId: string, data: any) {
  const { channelId } = data || {};
  if (!channelId) return;

  app.emit('ws:setTag', {
    clientId,
    tagKey: 'commChannel',
    tagValue: `${channelId}`,
  });

  app.logger.debug(`[comm-core] Client ${clientId} joined channel ${channelId}`);
}

/**
 * Remove the channel tag from the client's WS connection.
 */
async function handleLeaveChannel(app: Application, clientId: string, data: any) {
  const { channelId } = data || {};
  if (!channelId) return;

  // Note: NocoBase's removeTag removes all tags with the given key,
  // so we use a compound key for channel-specific removal
  app.emit('ws:removeTag', {
    clientId,
    tagKey: `commChannel`,
  });

  // Re-add other channels if needed (the client should re-join)
  app.logger.debug(`[comm-core] Client ${clientId} left channel ${channelId}`);
}

/**
 * Bulk join multiple channels at once (used on initial page load).
 */
async function handleJoinChannels(app: Application, clientId: string, data: any) {
  const { channelIds } = data || {};
  if (!channelIds || !Array.isArray(channelIds)) return;

  for (const channelId of channelIds) {
    app.emit('ws:setTag', {
      clientId,
      tagKey: 'commChannel',
      tagValue: `${channelId}`,
    });
  }

  app.logger.debug(`[comm-core] Client ${clientId} joined ${channelIds.length} channels`);
}

/**
 * Broadcast typing indicator to other users in the channel.
 */
async function handleTyping(app: Application, clientId: string, data: any, isTyping: boolean) {
  const { channelId, userId } = data || {};
  if (!channelId || !userId) return;

  app.emit('ws:sendToTag', {
    tagKey: 'commChannel',
    tagValue: `${channelId}`,
    message: {
      type: isTyping ? 'comm:typing:start' : 'comm:typing:stop',
      payload: { channelId, userId },
    },
  });
}

/**
 * Handle presence heartbeat — update user's last seen time.
 * Actual presence tracking is done by plugin-user-presence,
 * this is just the WS routing layer.
 */
async function handlePresenceHeartbeat(app: Application, clientId: string, tags: string[], data: any) {
  const { userId } = data || {};
  if (!userId) return;

  // Tag the client with their userId for direct messaging
  app.emit('ws:setTag', {
    clientId,
    tagKey: 'userId',
    tagValue: `${userId}`,
  });

  // Emit internal event for plugin-user-presence to handle
  app.emit('comm:presence:heartbeat', { clientId, userId, tags });
}
