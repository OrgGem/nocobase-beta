import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'apiRequestLogs',
  title: 'API Request Logs',
  fields: [
    {
      type: 'string',
      name: 'requestId',
      index: true,
    },
    {
      type: 'bigInt',
      name: 'routeId',
      index: true,
    },
    {
      type: 'string',
      name: 'routeName',
    },
    {
      type: 'string',
      name: 'direction',
    },
    {
      type: 'string',
      name: 'method',
    },
    {
      type: 'string',
      name: 'path',
    },
    {
      type: 'bigInt',
      name: 'partnerId',
    },
    {
      type: 'bigInt',
      name: 'apiKeyId',
    },
    {
      type: 'string',
      name: 'clientIp',
    },
    {
      type: 'text',
      name: 'userAgent',
    },
    {
      type: 'string',
      name: 'status',
      index: true,
    },
    {
      type: 'integer',
      name: 'httpStatus',
    },
    {
      type: 'integer',
      name: 'upstreamStatus',
    },
    {
      type: 'integer',
      name: 'attempt',
    },
    {
      type: 'string',
      name: 'errorCode',
    },
    {
      type: 'text',
      name: 'error',
    },
    {
      type: 'integer',
      name: 'requestBytes',
    },
    {
      type: 'integer',
      name: 'responseBytes',
    },
    {
      type: 'string',
      name: 'requestSha256',
    },
    {
      type: 'string',
      name: 'responseSha256',
    },
    {
      type: 'text',
      name: 'requestPayload',
    },
    {
      type: 'text',
      name: 'responsePayload',
    },
    {
      type: 'date',
      name: 'startedAt',
    },
    {
      type: 'date',
      name: 'finishedAt',
    },
    {
      type: 'integer',
      name: 'durationMs',
    },
    {
      type: 'date',
      name: 'createdAt',
      index: true,
    },
  ],
});
