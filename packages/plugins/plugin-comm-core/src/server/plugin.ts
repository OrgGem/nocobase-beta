import { Plugin } from '@nocobase/server';
import path from 'path';
import { commWsHandler } from './ws-handler';

/**
 * PluginCommCoreServer — Foundation layer for the Communication Suite.
 *
 * Responsibilities:
 * 1. Register all shared database collections (channels, messages, members, status, meetings)
 * 2. Register ACL snippets for comm resources
 * 3. Set up WebSocket message routing for comm:* events
 * 4. Provide custom resource actions (channel management, message CRUD)
 * 5. Emit lifecycle events for other plugins to hook into
 */
export class PluginCommCoreServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    // 1. Import all collection definitions
    await this.db.import({
      directory: path.resolve(__dirname, 'collections'),
    });

    // 2. Register ACL snippet for admin access to comm resources
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: [
        'commChannels:*',
        'commChannelMembers:*',
        'commMessages:*',
        'commUserStatus:*',
        'commMeetings:*',
        'commMeetingParticipants:*',
      ],
    });

    // 3. Allow logged-in users to access comm resources (with filtered permissions)
    this.app.acl.allow('commChannels', ['list', 'get'], 'loggedIn');
    this.app.acl.allow('commChannelMembers', ['list', 'get'], 'loggedIn');
    this.app.acl.allow('commMessages', ['list', 'get', 'create'], 'loggedIn');
    this.app.acl.allow('commUserStatus', ['list', 'get', 'update'], 'loggedIn');

    // 4. Register custom resource actions for channel management
    this.registerChannelActions();
    this.registerMessageActions();

    // 5. Set up WebSocket message handler for comm events
    commWsHandler(this.app, this);

    // 6. Hook into message creation for realtime broadcast
    this.db.on('commMessages.afterCreate', async (model, options) => {
      const message = model.toJSON();
      const channelId = message.channelId;

      // Broadcast new message to all clients in the channel via WS tags
      this.app.emit('ws:sendToTag', {
        tagKey: 'commChannel',
        tagValue: `${channelId}`,
        message: {
          type: 'comm:message:new',
          payload: {
            channelId,
            message,
          },
        },
      });

      // Update channel's lastActivityAt
      const channelRepo = this.db.getRepository('commChannels');
      await channelRepo.update({
        filterByTk: channelId,
        values: { lastActivityAt: new Date() },
      });
    });

    // 7. Hook into message update for realtime sync
    this.db.on('commMessages.afterUpdate', async (model, options) => {
      const message = model.toJSON();
      const channelId = message.channelId;

      this.app.emit('ws:sendToTag', {
        tagKey: 'commChannel',
        tagValue: `${channelId}`,
        message: {
          type: 'comm:message:update',
          payload: {
            channelId,
            messageId: message.id,
            message,
          },
        },
      });
    });

    this.app.logger.info('[comm-core] Plugin loaded successfully');
  }

  /**
   * Register custom actions for channel resource.
   */
  private registerChannelActions() {
    // Custom action: create channel with auto-join creator as owner
    this.app.resourceManager.registerActionHandler('commChannels:createWithOwner', async (ctx, next) => {
      const { values } = ctx.action.params;
      const userId = ctx.state.currentUser?.id;

      if (!userId) {
        ctx.throw(401, 'Authentication required');
      }

      const channelRepo = this.db.getRepository('commChannels');
      const memberRepo = this.db.getRepository('commChannelMembers');

      // Create the channel
      const channel = await channelRepo.create({
        values: {
          ...values,
          createdById: userId,
          lastActivityAt: new Date(),
        },
      });

      // Auto-add creator as owner
      await memberRepo.create({
        values: {
          channelId: channel.id,
          userId,
          role: 'owner',
          joinedAt: new Date(),
          lastReadAt: new Date(),
        },
      });

      // If other members were specified, add them
      if (values.memberIds && Array.isArray(values.memberIds)) {
        for (const memberId of values.memberIds) {
          if (memberId !== userId) {
            await memberRepo.create({
              values: {
                channelId: channel.id,
                userId: memberId,
                role: 'member',
                joinedAt: new Date(),
              },
            });
          }
        }
      }

      ctx.body = channel;
      await next();
    });

    // Custom action: join a channel
    this.app.resourceManager.registerActionHandler('commChannels:join', async (ctx, next) => {
      const { filterByTk } = ctx.action.params;
      const userId = ctx.state.currentUser?.id;

      if (!userId) {
        ctx.throw(401, 'Authentication required');
      }

      const memberRepo = this.db.getRepository('commChannelMembers');

      // Check if already a member
      const existing = await memberRepo.findOne({
        filter: { channelId: filterByTk, userId },
      });

      if (existing) {
        ctx.body = existing;
        await next();
        return;
      }

      const member = await memberRepo.create({
        values: {
          channelId: filterByTk,
          userId,
          role: 'member',
          joinedAt: new Date(),
        },
      });

      // Broadcast member joined event
      this.app.emit('ws:sendToTag', {
        tagKey: 'commChannel',
        tagValue: `${filterByTk}`,
        message: {
          type: 'comm:member:joined',
          payload: { channelId: filterByTk, userId },
        },
      });

      ctx.body = member;
      await next();
    });

    // Custom action: leave a channel
    this.app.resourceManager.registerActionHandler('commChannels:leave', async (ctx, next) => {
      const { filterByTk } = ctx.action.params;
      const userId = ctx.state.currentUser?.id;

      if (!userId) {
        ctx.throw(401, 'Authentication required');
      }

      const memberRepo = this.db.getRepository('commChannelMembers');

      await memberRepo.destroy({
        filter: { channelId: filterByTk, userId },
      });

      // Broadcast member left event
      this.app.emit('ws:sendToTag', {
        tagKey: 'commChannel',
        tagValue: `${filterByTk}`,
        message: {
          type: 'comm:member:left',
          payload: { channelId: filterByTk, userId },
        },
      });

      ctx.body = { success: true };
      await next();
    });

    // Custom action: get channels for current user
    this.app.resourceManager.registerActionHandler('commChannels:myChannels', async (ctx, next) => {
      const userId = ctx.state.currentUser?.id;

      if (!userId) {
        ctx.throw(401, 'Authentication required');
      }

      const memberRepo = this.db.getRepository('commChannelMembers');
      const memberships = await memberRepo.find({
        filter: { userId },
        appends: ['channel'],
      });

      ctx.body = memberships.map((m: any) => ({
        ...m.channel?.toJSON(),
        membership: {
          role: m.role,
          isPinned: m.isPinned,
          isMuted: m.isMuted,
          lastReadAt: m.lastReadAt,
          lastReadMessageId: m.lastReadMessageId,
          notificationPref: m.notificationPref,
        },
      }));

      await next();
    });
  }

  /**
   * Register custom actions for message resource.
   */
  private registerMessageActions() {
    // Custom action: mark channel as read
    this.app.resourceManager.registerActionHandler('commMessages:markRead', async (ctx, next) => {
      const { filterByTk: channelId } = ctx.action.params;
      const { messageId } = ctx.action.params.values || {};
      const userId = ctx.state.currentUser?.id;

      if (!userId) {
        ctx.throw(401, 'Authentication required');
      }

      const memberRepo = this.db.getRepository('commChannelMembers');

      await memberRepo.update({
        filter: { channelId, userId },
        values: {
          lastReadAt: new Date(),
          lastReadMessageId: messageId || null,
        },
      });

      ctx.body = { success: true };
      await next();
    });

    // Custom action: add reaction to a message
    this.app.resourceManager.registerActionHandler('commMessages:react', async (ctx, next) => {
      const { filterByTk: messageId } = ctx.action.params;
      const { emoji } = ctx.action.params.values || {};
      const userId = ctx.state.currentUser?.id;

      if (!userId || !emoji) {
        ctx.throw(400, 'userId and emoji required');
      }

      const messageRepo = this.db.getRepository('commMessages');
      const message = await messageRepo.findOne({ filterByTk: messageId });

      if (!message) {
        ctx.throw(404, 'Message not found');
      }

      const metadata = message.metadata || {};
      const reactions = metadata.reactions || {};
      const emojiUsers = reactions[emoji] || [];

      if (emojiUsers.includes(userId)) {
        // Toggle off — remove reaction
        reactions[emoji] = emojiUsers.filter((id: string) => id !== userId);
        if (reactions[emoji].length === 0) {
          delete reactions[emoji];
        }
      } else {
        // Toggle on — add reaction
        reactions[emoji] = [...emojiUsers, userId];
      }

      await messageRepo.update({
        filterByTk: messageId,
        values: { metadata: { ...metadata, reactions } },
      });

      ctx.body = { success: true, reactions };
      await next();
    });
  }

  async install() {
    // Seed a default "General" public channel on first install
    const channelRepo = this.db.getRepository('commChannels');
    const existing = await channelRepo.findOne({ filter: { name: 'General' } });

    if (!existing) {
      await channelRepo.create({
        values: {
          name: 'General',
          type: 'public',
          description: 'Default public channel for team communication',
          lastActivityAt: new Date(),
        },
      });
      this.app.logger.info('[comm-core] Created default "General" channel');
    }
  }

  async afterEnable() {}
  async afterDisable() {}
  async remove() {}
}

export default PluginCommCoreServer;
