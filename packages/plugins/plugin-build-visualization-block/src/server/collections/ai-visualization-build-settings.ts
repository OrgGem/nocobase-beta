import { defineCollection } from '@nocobase/database';

/**
 * Singleton plugin settings for default build inputs. LLM provider credentials
 * stay owned by the AI plugin; this collection only stores the defaults this
 * plugin should prefill when a user starts a visualization-block build.
 */
export default defineCollection({
  name: 'aiVisualizationBuildSettings',
  shared: true,
  dumpRules: 'required',
  migrationRules: ['overwrite', 'schema-only'],
  fields: [
    {
      type: 'bigInt',
      name: 'id',
      primaryKey: true,
      autoIncrement: true,
    },
    {
      type: 'string',
      name: 'defaultDataSource',
    },
    {
      type: 'json',
      name: 'defaultCollections',
      defaultValue: [],
    },
    {
      type: 'string',
      name: 'defaultLLMService',
    },
    {
      type: 'string',
      name: 'defaultModel',
    },
    {
      type: 'boolean',
      name: 'enableAITool',
      defaultValue: true,
    },
  ],
});
