import { CollectionOptions } from '@nocobase/database';

/**
 * User presence status — tracks online/offline state, custom status, and active channel.
 * One row per user (upserted). Used by plugin-user-presence for realtime tracking.
 */
export default {
  name: 'commUserStatus',
  title: 'User Status',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      name: 'user',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'userId',
      unique: true,
    },
    {
      // 'online' | 'away' | 'busy' | 'offline'
      name: 'status',
      type: 'string',
      length: 20,
      defaultValue: 'offline',
    },
    {
      // User-set status text, e.g. "In a meeting", "On vacation"
      name: 'customStatus',
      type: 'string',
      length: 255,
    },
    {
      // Status emoji, e.g. "🏖️", "🔨"
      name: 'statusEmoji',
      type: 'string',
      length: 10,
    },
    {
      name: 'lastSeenAt',
      type: 'date',
    },
    {
      // Which channel the user is currently viewing (for presence indicator)
      name: 'currentChannel',
      type: 'belongsTo',
      target: 'commChannels',
      foreignKey: 'currentChannelId',
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
