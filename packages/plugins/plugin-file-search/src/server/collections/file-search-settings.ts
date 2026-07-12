import { defineCollection } from '@nocobase/database';
import { DEFAULT_SETTINGS } from '../constants';

export default defineCollection({
  name: 'fileSearchSettings',
  title: 'File search settings',
  filterTargetKey: 'id',
  fields: [
    { type: 'string', name: 'singletonKey', unique: true, defaultValue: 'default' },
    { type: 'boolean', name: 'enabled', defaultValue: DEFAULT_SETTINGS.enabled },
    { type: 'boolean', name: 'autoIndex', defaultValue: DEFAULT_SETTINGS.autoIndex },
    { type: 'boolean', name: 'enableAiTool', defaultValue: DEFAULT_SETTINGS.enableAiTool },
    { type: 'string', name: 'parserStrategy', defaultValue: DEFAULT_SETTINGS.parserStrategy },
    { type: 'string', name: 'llmService' },
    { type: 'string', name: 'indexModel' },
    { type: 'string', name: 'retrieveModel' },
    { type: 'string', name: 'pageIndexWorkspace', defaultValue: DEFAULT_SETTINGS.pageIndexWorkspace },
    { type: 'string', name: 'pageIndexPythonCommand', defaultValue: DEFAULT_SETTINGS.pageIndexPythonCommand },
    { type: 'integer', name: 'maxFileSizeMb', defaultValue: DEFAULT_SETTINGS.maxFileSizeMb },
    { type: 'json', name: 'allowedExtnames', defaultValue: DEFAULT_SETTINGS.allowedExtnames },
    { type: 'integer', name: 'concurrency', defaultValue: DEFAULT_SETTINGS.concurrency },
    { type: 'integer', name: 'timeoutMs', defaultValue: DEFAULT_SETTINGS.timeoutMs },
  ],
});
