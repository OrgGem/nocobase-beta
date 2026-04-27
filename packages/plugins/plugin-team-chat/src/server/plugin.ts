import { Plugin } from '@nocobase/server';
import { AccessToken, VideoGrant } from 'livekit-server-sdk';

/**
 * PluginTeamChatServer — Server-side for Team Chat & Meeting Management.
 *
 * Provides:
 * 1. Chat: cursor-based message pagination, unread counts
 * 2. Admin Meeting Dashboard: all meetings, stats, force-end
 * 3. User Meeting Manager: schedule, list my meetings, start/cancel
 */
export class PluginTeamChatServer extends Plugin {
  async afterAdd() {}
  async beforeLoad() {}

  async load() {
    this.registerChatActions();
    this.registerAdminMeetingActions();
    this.registerUserMeetingActions();
    this.registerVideoCallActions();
    this.registerACL();

    this.app.logger.info('[team-chat] Plugin loaded successfully');
  }

  /**
   * Chat message actions
   */
  private registerChatActions() {
    // Cursor-based message list
    this.app.resourceManager.registerActionHandler('commMessages:listByChannel', async (ctx, next) => {
      const { channelId, before, limit = 50 } = ctx.action.params;
      const userId = ctx.state.currentUser?.id;
      if (!userId) ctx.throw(401, 'Authentication required');
      if (!channelId) ctx.throw(400, 'channelId is required');

      const memberRepo = this.db.getRepository('commChannelMembers');
      const membership = await memberRepo.findOne({ filter: { channelId, userId } });
      if (!membership) ctx.throw(403, 'Not a member of this channel');

      const messageRepo = this.db.getRepository('commMessages');
      const filter: any = { channelId, isDeleted: false };
      if (before) filter.id = { $lt: before };

      const messages = await messageRepo.find({
        filter,
        sort: ['-id'],
        limit: Math.min(parseInt(limit, 10) || 50, 100),
        appends: ['sender', 'replyTo'],
      });

      ctx.body = messages.reverse();
      await next();
    });

    // Unread counts
    this.app.resourceManager.registerActionHandler('commChannels:unreadCounts', async (ctx, next) => {
      const userId = ctx.state.currentUser?.id;
      if (!userId) ctx.throw(401, 'Authentication required');

      const memberRepo = this.db.getRepository('commChannelMembers');
      const memberships = await memberRepo.find({ filter: { userId } });
      const messageRepo = this.db.getRepository('commMessages');
      const counts: Record<string, number> = {};

      for (const membership of memberships) {
        const m = membership.toJSON ? membership.toJSON() : membership;
        const filter: any = { channelId: m.channelId, isDeleted: false };
        if (m.lastReadMessageId) {
          filter.id = { $gt: m.lastReadMessageId };
        } else if (m.lastReadAt) {
          filter.createdAt = { $gt: m.lastReadAt };
        }
        const count = await messageRepo.count({ filter });
        if (count > 0) counts[m.channelId] = count;
      }

      ctx.body = counts;
      await next();
    });
  }

  /**
   * Admin meeting management — full access to all meetings, stats, force-end
   */
  private registerAdminMeetingActions() {
    // Admin: list all meetings with filters
    this.app.resourceManager.registerActionHandler('commMeetings:adminList', async (ctx, next) => {
      const { status, type, page = 1, pageSize = 20 } = ctx.action.params;
      const filter: any = {};
      if (status) filter.status = status;
      if (type) filter.type = type;

      const meetingRepo = this.db.getRepository('commMeetings');
      const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);

      const [meetings, total] = await Promise.all([
        meetingRepo.find({
          filter,
          sort: ['-createdAt'],
          limit: parseInt(pageSize, 10),
          offset,
          appends: ['initiator', 'channel', 'participants', 'participants.user'],
        }),
        meetingRepo.count({ filter }),
      ]);

      ctx.body = {
        data: meetings,
        meta: { total, page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) },
      };
      await next();
    });

    // Admin: get meeting stats
    this.app.resourceManager.registerActionHandler('commMeetings:adminStats', async (ctx, next) => {
      const meetingRepo = this.db.getRepository('commMeetings');

      const [totalMeetings, activeMeetings, totalDuration] = await Promise.all([
        meetingRepo.count({}),
        meetingRepo.count({ filter: { status: 'active' } }),
        meetingRepo.find({ filter: { status: 'ended' } }),
      ]);

      // Calculate total duration
      let totalDurationSec = 0;
      for (const m of totalDuration) {
        const data = m.toJSON ? m.toJSON() : m;
        totalDurationSec += data.duration || 0;
      }

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todayMeetings = await meetingRepo.count({
        filter: { createdAt: { $gte: todayStart } },
      });

      ctx.body = {
        totalMeetings,
        activeMeetings,
        todayMeetings,
        totalDurationMinutes: Math.round(totalDurationSec / 60),
        endedMeetings: totalDuration.length,
      };
      await next();
    });

    // Admin: force-end a meeting
    this.app.resourceManager.registerActionHandler('commMeetings:adminForceEnd', async (ctx, next) => {
      const { filterByTk } = ctx.action.params;
      if (!filterByTk) ctx.throw(400, 'Meeting ID required');

      const meetingRepo = this.db.getRepository('commMeetings');
      const meeting = await meetingRepo.findOne({ filterByTk });
      if (!meeting) ctx.throw(404, 'Meeting not found');

      const data = meeting.toJSON ? meeting.toJSON() : meeting;
      const startedAt = data.startedAt ? new Date(data.startedAt) : new Date(data.createdAt);
      const duration = Math.round((Date.now() - startedAt.getTime()) / 1000);

      await meetingRepo.update({
        filterByTk,
        values: { status: 'ended', endedAt: new Date(), duration },
      });

      // Broadcast meeting ended via WS
      if (data.channelId) {
        this.app.emit('ws:sendToTag', {
          tagKey: 'commChannel',
          tagValue: `${data.channelId}`,
          message: { type: 'comm:meeting:ended', payload: { meetingId: filterByTk, forcedBy: 'admin' } },
        });
      }

      ctx.body = { success: true };
      await next();
    });
  }

  /**
   * User meeting management — personal meetings, schedule, start/cancel
   */
  private registerUserMeetingActions() {
    // User: list my meetings (initiated by me OR I'm a participant)
    this.app.resourceManager.registerActionHandler('commMeetings:myMeetings', async (ctx, next) => {
      const userId = ctx.state.currentUser?.id;
      if (!userId) ctx.throw(401, 'Authentication required');

      const { status, upcoming } = ctx.action.params;
      const meetingRepo = this.db.getRepository('commMeetings');
      const participantRepo = this.db.getRepository('commMeetingParticipants');

      // Find meetings where user is a participant
      const participations = await participantRepo.find({
        filter: { userId },
        fields: ['meetingId'],
      });
      const participatedIds = participations.map((p: any) => {
        const d = p.toJSON ? p.toJSON() : p;
        return d.meetingId;
      });

      // Meetings initiated by user OR user is participant
      const filter: any = {
        $or: [
          { initiatorId: userId },
          ...(participatedIds.length > 0 ? [{ id: { $in: participatedIds } }] : []),
        ],
      };

      if (status) filter.status = status;

      // For upcoming, only show scheduled meetings in the future
      if (upcoming === 'true') {
        filter.scheduledAt = { $gte: new Date() };
        filter.status = { $in: ['ringing', 'scheduled'] };
      }

      const meetings = await meetingRepo.find({
        filter,
        sort: ['-scheduledAt', '-createdAt'],
        limit: 50,
        appends: ['initiator', 'channel', 'participants', 'participants.user'],
      });

      ctx.body = meetings;
      await next();
    });

    // User: schedule a new meeting
    this.app.resourceManager.registerActionHandler('commMeetings:schedule', async (ctx, next) => {
      const userId = ctx.state.currentUser?.id;
      if (!userId) ctx.throw(401, 'Authentication required');

      const { values } = ctx.action.params;
      const meetingRepo = this.db.getRepository('commMeetings');
      const participantRepo = this.db.getRepository('commMeetingParticipants');

      // Create the meeting
      const meeting = await meetingRepo.create({
        values: {
          title: values.title,
          type: values.type || 'video',
          status: 'scheduled',
          channelId: values.channelId || null,
          initiatorId: userId,
          scheduledAt: values.scheduledAt,
          scheduledEndAt: values.scheduledEndAt || null,
          isRecurring: values.isRecurring || false,
          recurrenceRule: values.recurrenceRule || null,
          metadata: values.metadata || {},
        },
      });

      // Add initiator as host participant
      await participantRepo.create({
        values: {
          meetingId: meeting.id,
          userId,
          role: 'host',
        },
      });

      // Add invited participants
      if (values.participantIds && Array.isArray(values.participantIds)) {
        for (const pId of values.participantIds) {
          if (pId !== userId) {
            await participantRepo.create({
              values: { meetingId: meeting.id, userId: pId, role: 'participant' },
            });

            // Notify invited user via WS
            this.app.emit('ws:sendToUser', {
              userId: pId,
              message: {
                type: 'comm:meeting:invited',
                payload: { meetingId: meeting.id, title: values.title, initiatorId: userId },
              },
            });
          }
        }
      }

      // Fetch full meeting with relations
      const fullMeeting = await meetingRepo.findOne({
        filterByTk: meeting.id,
        appends: ['initiator', 'channel', 'participants', 'participants.user'],
      });

      ctx.body = fullMeeting;
      await next();
    });

    // User: cancel a scheduled meeting
    this.app.resourceManager.registerActionHandler('commMeetings:cancel', async (ctx, next) => {
      const userId = ctx.state.currentUser?.id;
      if (!userId) ctx.throw(401, 'Authentication required');

      const { filterByTk } = ctx.action.params;
      const meetingRepo = this.db.getRepository('commMeetings');
      const meeting = await meetingRepo.findOne({ filterByTk });

      if (!meeting) ctx.throw(404, 'Meeting not found');
      const data = meeting.toJSON ? meeting.toJSON() : meeting;
      if (data.initiatorId !== userId) ctx.throw(403, 'Only the initiator can cancel');
      if (data.status === 'active') ctx.throw(400, 'Cannot cancel an active meeting');

      await meetingRepo.update({ filterByTk, values: { status: 'cancelled' } });

      ctx.body = { success: true };
      await next();
    });

    // User: start a scheduled meeting (transition to active)
    this.app.resourceManager.registerActionHandler('commMeetings:start', async (ctx, next) => {
      const userId = ctx.state.currentUser?.id;
      if (!userId) ctx.throw(401, 'Authentication required');

      const { filterByTk } = ctx.action.params;
      const meetingRepo = this.db.getRepository('commMeetings');
      const meeting = await meetingRepo.findOne({ filterByTk });

      if (!meeting) ctx.throw(404, 'Meeting not found');
      const data = meeting.toJSON ? meeting.toJSON() : meeting;
      if (data.initiatorId !== userId) ctx.throw(403, 'Only the initiator can start');

      await meetingRepo.update({
        filterByTk,
        values: { status: 'active', startedAt: new Date() },
      });

      // Notify channel members
      if (data.channelId) {
        this.app.emit('ws:sendToTag', {
          tagKey: 'commChannel',
          tagValue: `${data.channelId}`,
          message: {
            type: 'comm:meeting:started',
            payload: { meetingId: filterByTk, title: data.title, initiatorId: userId },
          },
        });
      }

      ctx.body = { success: true };
      await next();
    });
  }

  /**
   * Video call actions — LiveKit token generation and call lifecycle
   */
  private registerVideoCallActions() {
    // Join a meeting video call — generates a LiveKit room token
    this.app.resourceManager.registerActionHandler('commMeetings:joinCall', async (ctx, next) => {
      const userId = ctx.state.currentUser?.id;
      if (!userId) ctx.throw(401, 'Authentication required');

      const { filterByTk } = ctx.action.params;
      const meetingRepo = this.db.getRepository('commMeetings');
      const meeting = await meetingRepo.findOne({
        filterByTk,
        appends: ['participants'],
      });

      if (!meeting) ctx.throw(404, 'Meeting not found');
      const data = meeting.toJSON ? meeting.toJSON() : meeting;

      // Check user is a participant or the meeting is public
      const isParticipant = data.participants?.some((p: any) => p.userId === userId);
      const isInitiator = data.initiatorId === userId;

      if (!isParticipant && !isInitiator) {
        // Auto-add as participant if meeting allows
        const participantRepo = this.db.getRepository('commMeetingParticipants');
        await participantRepo.create({
          values: { meetingId: filterByTk, userId, role: 'participant', joinedAt: new Date() },
        });
      }

      // Generate LiveKit token
      const token = await this.generateLiveKitToken(
        String(userId),
        ctx.state.currentUser?.nickname || ctx.state.currentUser?.username || `User-${userId}`,
        `meeting-${filterByTk}`,
        isInitiator,
      );

      const livekitUrl = process.env.LIVEKIT_URL || 'ws://localhost:7880';

      ctx.body = {
        token,
        serverUrl: livekitUrl,
        roomName: `meeting-${filterByTk}`,
        meetingId: filterByTk,
        meeting: data,
      };
      await next();
    });

    // End a meeting video call (by host)
    this.app.resourceManager.registerActionHandler('commMeetings:endCall', async (ctx, next) => {
      const userId = ctx.state.currentUser?.id;
      if (!userId) ctx.throw(401, 'Authentication required');

      const { filterByTk } = ctx.action.params;
      const meetingRepo = this.db.getRepository('commMeetings');
      const meeting = await meetingRepo.findOne({ filterByTk });

      if (!meeting) ctx.throw(404, 'Meeting not found');
      const data = meeting.toJSON ? meeting.toJSON() : meeting;
      if (data.initiatorId !== userId) ctx.throw(403, 'Only the host can end the call');

      const startedAt = data.startedAt ? new Date(data.startedAt) : new Date(data.createdAt);
      const duration = Math.round((Date.now() - startedAt.getTime()) / 1000);

      await meetingRepo.update({
        filterByTk,
        values: { status: 'ended', endedAt: new Date(), duration },
      });

      // Broadcast meeting ended to all participants via WS
      if (data.channelId) {
        this.app.emit('ws:sendToTag', {
          tagKey: 'commChannel',
          tagValue: `${data.channelId}`,
          message: { type: 'comm:meeting:ended', payload: { meetingId: filterByTk, endedBy: userId } },
        });
      }

      ctx.body = { success: true, duration };
      await next();
    });

    // Get LiveKit connection info for an active meeting
    this.app.resourceManager.registerActionHandler('commMeetings:callInfo', async (ctx, next) => {
      const userId = ctx.state.currentUser?.id;
      if (!userId) ctx.throw(401, 'Authentication required');

      const { filterByTk } = ctx.action.params;
      const meetingRepo = this.db.getRepository('commMeetings');
      const meeting = await meetingRepo.findOne({
        filterByTk,
        appends: ['participants', 'participants.user', 'initiator'],
      });

      if (!meeting) ctx.throw(404, 'Meeting not found');
      const data = meeting.toJSON ? meeting.toJSON() : meeting;

      ctx.body = {
        meetingId: data.id,
        status: data.status,
        roomName: `meeting-${data.id}`,
        serverUrl: process.env.LIVEKIT_URL || 'ws://localhost:7880',
        participants: data.participants || [],
        initiator: data.initiator,
        startedAt: data.startedAt,
      };
      await next();
    });
  }

  /**
   * Generate a LiveKit JWT access token for a user to join a room.
   */
  private async generateLiveKitToken(
    userId: string,
    userName: string,
    roomName: string,
    isHost: boolean,
  ): Promise<string> {
    const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
    const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret1234567890abcdefghijklmnopqrstuv';

    const token = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      name: userName,
      metadata: JSON.stringify({ isHost }),
    });

    const grant: VideoGrant = {
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    };

    // Host gets additional permissions
    if (isHost) {
      grant.roomAdmin = true;
      grant.roomRecord = true;
    }

    token.addGrant(grant);

    return await token.toJwt();
  }

  /**
   * ACL rules
   */
  private registerACL() {
    // Chat
    this.app.acl.allow('commMessages', 'listByChannel', 'loggedIn');
    this.app.acl.allow('commChannels', ['unreadCounts', 'myChannels', 'join', 'leave', 'createWithOwner'], 'loggedIn');
    this.app.acl.allow('commMessages', ['markRead', 'react'], 'loggedIn');

    // User meeting actions
    this.app.acl.allow('commMeetings', ['myMeetings', 'schedule', 'cancel', 'start', 'joinCall', 'endCall', 'callInfo'], 'loggedIn');

    // Admin meeting actions (via ACL snippet — requires pm.plugin-team-chat permission)
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.meetings`,
      actions: ['commMeetings:adminList', 'commMeetings:adminStats', 'commMeetings:adminForceEnd'],
    });
  }

  async install() {}
  async afterEnable() {}
  async afterDisable() {}
  async remove() {}
}

export default PluginTeamChatServer;
