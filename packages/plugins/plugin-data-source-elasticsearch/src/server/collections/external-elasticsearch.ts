/**
 * Dummy metadata collection for the custom external-elasticsearch resource.
 *
 * Some framework hooks expect a collection with the same name as a registered
 * resource. The collection is skipped by dump/migration flows and is not used
 * for Elasticsearch data.
 */
export default {
  name: 'external-elasticsearch',
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
