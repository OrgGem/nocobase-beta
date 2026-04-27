import { CollectionOptions } from '@nocobase/database';

/**
 * Meeting records — tracks video/audio call sessions with participants and duration.
 * Used by plugin-video-meeting.
 */
export default {
  name: 'commMeetings',
  title: 'Meetings',
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
      name: 'initiator',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'initiatorId',
    },
    {
      // 'audio' | 'video' | 'screen_share'
      name: 'type',
      type: 'string',
      length: 20,
      defaultValue: 'video',
    },
    {
      // 'ringing' | 'active' | 'ended' | 'missed' | 'declined'
      name: 'status',
      type: 'string',
      length: 20,
      defaultValue: 'ringing',
    },
    {
      name: 'title',
      type: 'string',
      length: 255,
    },
    {
      // When the meeting is scheduled to start (for scheduling feature)
      name: 'scheduledAt',
      type: 'date',
    },
    {
      // When the meeting is scheduled to end
      name: 'scheduledEndAt',
      type: 'date',
    },
    {
      // Whether this is a recurring meeting
      name: 'isRecurring',
      type: 'boolean',
      defaultValue: false,
    },
    {
      // Recurrence rule (RRULE format: FREQ=WEEKLY;BYDAY=MO,WE,FR)
      name: 'recurrenceRule',
      type: 'string',
      length: 500,
    },
    {
      name: 'startedAt',
      type: 'date',
    },
    {
      name: 'endedAt',
      type: 'date',
    },
    {
      // Duration in seconds
      name: 'duration',
      type: 'integer',
      defaultValue: 0,
    },
    {
      // URL to recording if recorded
      name: 'recordingUrl',
      type: 'string',
      length: 1000,
    },
    {
      // Flexible metadata: quality metrics, settings, etc.
      name: 'metadata',
      type: 'json',
      defaultValue: {},
    },
    {
      name: 'participants',
      type: 'hasMany',
      target: 'commMeetingParticipants',
      foreignKey: 'meetingId',
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
