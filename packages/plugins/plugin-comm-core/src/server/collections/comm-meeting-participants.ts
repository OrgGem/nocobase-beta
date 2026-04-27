import { CollectionOptions } from '@nocobase/database';

/**
 * Meeting participants — tracks who joined a meeting and their media state.
 */
export default {
  name: 'commMeetingParticipants',
  title: 'Meeting Participants',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      name: 'meeting',
      type: 'belongsTo',
      target: 'commMeetings',
      foreignKey: 'meetingId',
    },
    {
      name: 'user',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'userId',
    },
    {
      // 'host' | 'participant'
      name: 'role',
      type: 'string',
      length: 20,
      defaultValue: 'participant',
    },
    {
      name: 'joinedAt',
      type: 'date',
    },
    {
      name: 'leftAt',
      type: 'date',
    },
    {
      // { audio: true, video: false, screen: false }
      name: 'mediaState',
      type: 'json',
      defaultValue: { audio: true, video: false, screen: false },
    },
    {
      name: 'createdAt',
      type: 'date',
    },
  ],
} as CollectionOptions;
