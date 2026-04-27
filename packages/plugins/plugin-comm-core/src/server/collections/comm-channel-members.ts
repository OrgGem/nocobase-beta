import { CollectionOptions } from '@nocobase/database';

/**
 * Channel membership — tracks who belongs to which channel and their role/preferences.
 * Also tracks unread state via lastReadAt.
 */
export default {
  name: 'commChannelMembers',
  title: 'Channel Members',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      name: 'channel',
      type: 'belongsTo',
      target: 'commChannels',
      foreignKey: 'channelId',
    },
    {
      name: 'user',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'userId',
    },
    {
      // 'owner' | 'admin' | 'member' | 'guest'
      name: 'role',
      type: 'string',
      length: 20,
      defaultValue: 'member',
    },
    {
      name: 'joinedAt',
      type: 'date',
    },
    {
      // Last time the user read messages in this channel — used for unread count
      name: 'lastReadAt',
      type: 'date',
    },
    {
      // Last message ID the user has seen — more precise than timestamp
      name: 'lastReadMessageId',
      type: 'bigInt',
    },
    {
      // 'all' | 'mentions' | 'none'
      name: 'notificationPref',
      type: 'string',
      length: 20,
      defaultValue: 'all',
    },
    {
      // Whether the user has muted this channel
      name: 'isMuted',
      type: 'boolean',
      defaultValue: false,
    },
    {
      // Whether the channel is pinned in the user's sidebar
      name: 'isPinned',
      type: 'boolean',
      defaultValue: false,
    },
    {
      name: 'createdAt',
      type: 'date',
    },
    {
      name: 'updatedAt',
      type: 'date',
    },
  ],
} as CollectionOptions;
