import { CollectionOptions } from '@nocobase/database';

/**
 * Chat messages — supports text, rich text, system events, file attachments, and call events.
 * Soft-delete via isDeleted flag. Thread support via replyToId.
 */
export default {
  name: 'commMessages',
  title: 'Chat Messages',
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
      name: 'sender',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'senderId',
    },
    {
      // Message body — plain text or HTML for rich text
      name: 'content',
      type: 'text',
    },
    {
      // 'text' | 'rich_text' | 'system' | 'file' | 'call_event' | 'image'
      name: 'contentType',
      type: 'string',
      length: 20,
      defaultValue: 'text',
    },
    {
      // Self-referencing for thread/reply support
      name: 'replyTo',
      type: 'belongsTo',
      target: 'commMessages',
      foreignKey: 'replyToId',
    },
    {
      // Flexible metadata: reactions, mentioned users, link previews, etc.
      // Example: { reactions: { "👍": ["userId1"], "❤️": ["userId2"] }, mentions: ["userId3"] }
      name: 'metadata',
      type: 'json',
      defaultValue: {},
    },
    {
      // File attachment references (array of attachment IDs)
      name: 'attachments',
      type: 'json',
      defaultValue: [],
    },
    {
      name: 'isEdited',
      type: 'boolean',
      defaultValue: false,
    },
    {
      // Soft delete — message body hidden but record kept for thread integrity
      name: 'isDeleted',
      type: 'boolean',
      defaultValue: false,
    },
    {
      name: 'editedAt',
      type: 'date',
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
