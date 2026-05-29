import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'attachmentOcrResults',
  title: 'Attachment OCR results',
  dumpRules: 'required',
  migrationRules: ['schema-only', 'overwrite'],
  indexes: [
    {
      fields: ['attachmentId'],
      unique: true,
    },
    {
      fields: ['status'],
    },
  ],
  fields: [
    {
      type: 'belongsTo',
      name: 'attachment',
      target: 'attachments',
      foreignKey: 'attachmentId',
      onDelete: 'CASCADE',
      interface: 'm2o',
    },
    {
      type: 'string',
      name: 'status',
      defaultValue: 'no-ocr',
    },
    {
      type: 'json',
      name: 'data',
    },
    {
      type: 'text',
      name: 'error',
    },
  ],
});
