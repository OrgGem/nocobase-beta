import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'databasePlusManagerSettings',
  fields: [
    {
      name: 'paginationMode',
      type: 'string',
      required: true,
      defaultValue: 'offset',
    },
  ],
});
