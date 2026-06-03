/**
 * DUMMY COLLECTION
 * Keeps the `clusterManagerDoctor` resourcer compatible with NocoBase
 * workflow/ACL collection lookups. Diagnostic run data lives in
 * `clusterManagerDoctorRuns`.
 */
export default {
  name: 'clusterManagerDoctor',
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
