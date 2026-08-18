import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'selectorSettings',
  title: 'Selector Registry Settings',
  fields: [
    { type: 'string', name: 'key', unique: true, allowNull: false },
    { type: 'json', name: 'values', defaultValue: {} },
  ],
});
