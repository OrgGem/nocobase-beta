/**
 * DUMMY COLLECTION
 * Keeps the `clusterManagerPlugins` resourcer compatible with NocoBase
 * workflow/ACL collection lookups. The actual plugin records live in
 * the core `applicationPlugins` collection.
 */
export default {
  name: 'clusterManagerPlugins',
  dumpRules: 'skip',
  autoGenId: true,
  createdAt: false,
  updatedAt: false,
  fields: [
    {
      name: 'name',
      type: 'string',
    },
  ],
};
