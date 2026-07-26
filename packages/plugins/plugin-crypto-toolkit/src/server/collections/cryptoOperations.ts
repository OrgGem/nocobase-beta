import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'cryptoOperations',
  title: 'Crypto Operations',
  updatedAt: false,
  fields: [
    { type: 'string', name: 'action', allowNull: false },
    { type: 'string', name: 'status', allowNull: false, defaultValue: 'success' },
    { type: 'string', name: 'algorithm' },
    { type: 'bigInt', name: 'keyId' },
    { type: 'bigInt', name: 'partnerKeyId' },
    { type: 'bigInt', name: 'inputBytes' },
    { type: 'bigInt', name: 'outputBytes' },
    { type: 'string', name: 'inputSha256' },
    { type: 'string', name: 'outputSha256' },
    { type: 'bigInt', name: 'inputAttachmentId' },
    { type: 'bigInt', name: 'outputAttachmentId' },
    { type: 'bigInt', name: 'userId' },
    { type: 'integer', name: 'durationMs' },
    { type: 'text', name: 'errorMessage' },
  ],
});
