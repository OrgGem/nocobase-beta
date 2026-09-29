import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'tenants',
  title: 'Tenants',
  sortable: 'sort',
  fields: [
    {
      name: 'name',
      type: 'string',
      unique: true,
      required: true,
    },
    {
      name: 'displayName',
      type: 'string',
    },
    // Slug used as the URL segment that replaces the modern-client prefix: /<pathPrefix>/...
    // Also the asset prefix the gateway maps back to the fixed dist dir (see ADR 0001).
    {
      name: 'pathPrefix',
      type: 'string',
      unique: true,
      required: true,
    },
    // Maps to an AppSupervisor application (its own DB). Defaults to pathPrefix when left blank.
    {
      name: 'appName',
      type: 'string',
    },
    {
      name: 'enabled',
      type: 'boolean',
      defaultValue: true,
    },
    {
      name: 'sort',
      type: 'sort',
    },
    {
      name: 'createdAt',
      type: 'createdAt',
    },
    {
      name: 'updatedAt',
      type: 'updatedAt',
    },
  ],
});
