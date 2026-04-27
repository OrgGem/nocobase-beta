import { CollectionOptions } from '@nocobase/database';

/**
 * Communication channels — supports DM, group chat, public channels, and meeting rooms.
 * This is the core organizational unit for all messaging.
 */
export default {
  name: 'commChannels',
  title: 'Communication Channels',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      name: 'name',
      type: 'string',
      length: 255,
    },
    {
      // 'direct' = 1-to-1 DM, 'group' = group DM, 'public' = open channel, 'meeting' = video call room
      name: 'type',
      type: 'string',
      length: 20,
      defaultValue: 'public',
    },
    {
      name: 'avatarUrl',
      type: 'string',
      length: 500,
    },
    {
      name: 'description',
      type: 'text',
    },
    {
      // Topic / current subject for the channel
      name: 'topic',
      type: 'string',
      length: 500,
    },
    {
      // Whether the channel is archived (read-only)
      name: 'isArchived',
      type: 'boolean',
      defaultValue: false,
    },
    {
      // Flexible metadata: pinned messages, custom settings, etc.
      name: 'metadata',
      type: 'json',
      defaultValue: {},
    },
    {
      // Timestamp of the last message or activity for sorting
      name: 'lastActivityAt',
      type: 'date',
    },
    {
      name: 'createdBy',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'createdById',
    },
    {
      name: 'members',
      type: 'hasMany',
      target: 'commChannelMembers',
      foreignKey: 'channelId',
    },
    {
      name: 'messages',
      type: 'hasMany',
      target: 'commMessages',
      foreignKey: 'channelId',
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
