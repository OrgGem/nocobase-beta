import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'sftpgoApiKeySecrets',
  title: 'SFTPGo API Key Secrets',
  fields: [
    {
      type: 'belongsTo',
      name: 'connection',
      target: 'sftpgoConnections',
      foreignKey: 'connectionId',
      onDelete: 'CASCADE',
    },
    { type: 'string', name: 'apiKeyId', allowNull: false },
    { type: 'string', name: 'name', allowNull: false },
    { type: 'text', name: 'encryptedSecret', allowNull: false, hidden: true },
  ],
  indexes: [
    {
      unique: true,
      fields: ['connectionId', 'apiKeyId'],
    },
  ],
});
