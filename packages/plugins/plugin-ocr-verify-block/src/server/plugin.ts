import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { COLLECTION, NAMESPACE } from '../shared/constants';
import { accept, getPayload, reject, saveDraft, testCallback } from './resources/verify';
import { ensureDefaultMapping, ensureSettings, getDefaultMapping, getSettings, saveSettings } from './resources/settings';

export class PluginOcrVerifyBlockServer extends Plugin {
  declare app: any;

  async install() {
    await ensureSettings(this.db);
    await ensureDefaultMapping(this.db);
  }

  async beforeLoad() {
    await this.db.import({ directory: resolve(__dirname, 'collections') });
  }

  async load() {
    if (this.db.getCollection(COLLECTION.categories)) {
      await this.db.getCollection(COLLECTION.categories).sync();
    }

    this.app.resourcer.registerActionHandlers({
      [`${COLLECTION.settings}:get`]: getSettings,
      [`${COLLECTION.settings}:save`]: saveSettings,
      [`${COLLECTION.settings}:testCallback`]: testCallback,
      [`${COLLECTION.mappingProfiles}:default`]: getDefaultMapping,
      'ocrVerify:getPayload': getPayload,
      'ocrVerify:saveDraft': saveDraft,
      'ocrVerify:accept': accept,
      'ocrVerify:reject': reject,
    });

    this.app.acl.registerSnippet({
      name: `pm.${NAMESPACE}.settings`,
      actions: [
        `${COLLECTION.settings}:get`,
        `${COLLECTION.settings}:save`,
        `${COLLECTION.settings}:testCallback`,
        `${COLLECTION.mappingProfiles}:*`,
        `${COLLECTION.categories}:*`,
      ],
    });

    this.app.acl.registerSnippet({
      name: `pm.${NAMESPACE}.verify`,
      actions: [
        'ocrVerify:*',
        `${COLLECTION.histories}:list`,
        `${COLLECTION.histories}:get`,
        `${COLLECTION.categories}:list`,
        `${COLLECTION.categories}:get`,
      ],
    });

    await this.registerSkillHubDefinition();
  }

  getSkillTemplates() {
    return [
      {
        name: 'ocr_verify_submit_result',
        title: 'OCR Verify - submit result',
        description:
          'Submit edited OCR JSON for a NocoBase record and mark it as saveDraft, accept, or reject through the OCR Verify Block API.',
        language: 'node',
        timeoutSeconds: 30,
        inputSchema: JSON.stringify({
          type: 'object',
          properties: {
            baseUrl: { type: 'string', description: 'NocoBase base URL, for example https://example.com' },
            apiToken: { type: 'string', description: 'NocoBase API token or bearer token' },
            collection: { type: 'string' },
            recordId: { type: ['string', 'number'] },
            pdfField: { type: 'string' },
            jsonField: { type: 'string' },
            statusField: { type: 'string' },
            action: { type: 'string', enum: ['saveDraft', 'accept', 'reject'] },
            data: { type: 'object' },
            items: { type: 'array', items: { type: 'object' } },
          },
          required: ['baseUrl', 'apiToken', 'collection', 'recordId', 'jsonField', 'action'],
        }),
        instructions:
          'Use this skill when an agent needs to submit verified OCR data back to NocoBase. The skill calls ocrVerify:saveDraft, ocrVerify:accept, or ocrVerify:reject and returns the API response.',
        codeTemplate: `
function decodeText(value, fallback = '') {
  if (!value || value.includes('{{')) return fallback;
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return fallback;
  }
}

function decodeJson(value, fallback) {
  const text = decodeText(value, '');
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

const input = {
  baseUrl: decodeText('{{baseUrl_b64}}'),
  apiToken: decodeText('{{apiToken_b64}}'),
  collection: decodeText('{{collection_b64}}'),
  recordId: decodeText('{{recordId_b64}}'),
  pdfField: decodeText('{{pdfField_b64}}'),
  jsonField: decodeText('{{jsonField_b64}}'),
  statusField: decodeText('{{statusField_b64}}'),
  action: decodeText('{{action_b64}}', 'saveDraft'),
  data: decodeJson('{{data_b64}}', undefined),
  items: decodeJson('{{items_b64}}', []),
};
const action = input.action || 'saveDraft';
if (!['saveDraft', 'accept', 'reject'].includes(action)) {
  throw new Error(\`Unsupported OCR verify action: \${action}\`);
}
const baseUrl = String(input.baseUrl || '').replace(/\\/$/, '');
const response = await fetch(\`\${baseUrl}/api/ocrVerify:\${action}\`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: \`Bearer \${input.apiToken}\`,
  },
  body: JSON.stringify({
    collection: input.collection,
    recordId: input.recordId,
    pdfField: input.pdfField,
    jsonField: input.jsonField,
    statusField: input.statusField,
    data: input.data,
    items: input.items || [],
  }),
});
const text = await response.text();
if (!response.ok) throw new Error(text);
console.log(text);
`,
      },
    ];
  }

  private async registerSkillHubDefinition() {
    try {
      const repo = this.db.getRepository('skillDefinitions');
      if (!repo) return;
      const template = this.getSkillTemplates()[0];
      const existing = await repo.findOne({ filter: { name: template.name } });
      const values = {
        name: template.name,
        title: template.title,
        description: template.description,
        instructions: template.instructions,
        language: template.language,
        inputSchema: template.inputSchema,
        codeTemplate: template.codeTemplate,
        timeoutSeconds: template.timeoutSeconds,
        maxOutputSizeMb: 1,
        enabled: true,
        toolScope: 'CUSTOM',
        autoCall: false,
        pluginSource: template.name,
        storageType: 'plugin',
        storageUrl: `plugin://${NAMESPACE}/${template.name}`,
      };
      if (existing) await repo.update({ filterByTk: existing.id, values });
      else await repo.create({ values });
    } catch {
      // Skill Hub is optional. The template is also exposed through getSkillTemplates()
      // for dynamic discovery when plugin-agent-orchestrator is enabled later.
    }
  }
}

export default PluginOcrVerifyBlockServer;
