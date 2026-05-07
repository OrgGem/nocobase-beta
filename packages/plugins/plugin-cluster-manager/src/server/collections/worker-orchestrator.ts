/**
 * DUMMY COLLECTION
 * This collection is created to prevent NocoBase workflow/ACL from throwing the error:
 * '[Workflow pre-action]: collection "workerOrchestrator" not found'
 * 
 * Since 'workerOrchestrator' is registered as a resourcer in plugin.ts, NocoBase 
 * implicitly looks for a collection with the same name.
 * We set dumpRules: 'skip' and avoid timestamps to ensure this collection 
 * is completely ignored during backups/migrations and doesn't pollute the actual DB.
 */
export default {
  name: 'workerOrchestrator',
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
