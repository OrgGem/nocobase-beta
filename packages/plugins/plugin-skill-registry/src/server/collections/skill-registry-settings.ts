import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'skillRegistrySettings',
  title: 'Skill Registry Settings',
  fields: [
    { type: 'string', name: 'key', unique: true, allowNull: false },
    { type: 'json', name: 'overrides', defaultValue: {} },
  ],
});
