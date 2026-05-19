import { defineCollection } from '@nocobase/database';
import { COLLECTION } from '../../shared/constants';

export default defineCollection({
  name: COLLECTION.histories,
  title: 'OCR Verify Histories',
  fields: [
    { name: 'dataSource', type: 'string', allowNull: true },
    { name: 'collectionName', type: 'string' },
    { name: 'recordId', type: 'string' },
    { name: 'pdfField', type: 'string', allowNull: true },
    { name: 'jsonField', type: 'string' },
    { name: 'statusField', type: 'string', allowNull: true },
    { name: 'action', type: 'string' },
    { name: 'status', type: 'string', allowNull: true },
    { name: 'beforeJson', type: 'json', allowNull: true },
    { name: 'afterJson', type: 'json', allowNull: true },
    { name: 'changedItems', type: 'json', allowNull: true },
    { name: 'callbackUrl', type: 'text', allowNull: true },
    { name: 'callbackStatus', type: 'string', allowNull: true },
    { name: 'callbackResponse', type: 'text', allowNull: true },
    { name: 'error', type: 'text', allowNull: true },
    { name: 'createdAt', type: 'date' },
    { name: 'createdBy', type: 'belongsTo', target: 'users', foreignKey: 'createdById' },
  ],
});
