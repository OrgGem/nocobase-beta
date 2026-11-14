// SPDX-License-Identifier: Apache-2.0

const namespace = 'plugin-workflow-git-review';

// This is client metadata for the internal Git Manager collection. It does not grant access to its records.
export const reviewRequestCollection = {
  name: 'gitReviewRequests',
  title: `{{t("Git review requests", { ns: "${namespace}" })}}`,
  hidden: true,
  filterTargetKey: 'id',
  titleField: 'id',
  fields: [
    {
      name: 'id',
      type: 'integer',
      primaryKey: true,
      interface: 'id',
      uiSchema: { type: 'number', title: '{{t("ID")}}', 'x-component': 'InputNumber' },
    },
    ...[
      ['inboxId', 'Inbox ID', 'integer'],
      ['reviewId', 'Review ID', 'integer'],
      ['repositoryId', 'Repository ID', 'integer'],
      ['flowId', 'Review flow ID', 'integer'],
      ['workflowId', 'Workflow ID', 'bigInt'],
      ['workflowKey', 'Workflow key', 'string'],
      ['eventType', 'Event type', 'string'],
      ['executionId', 'Execution ID', 'bigInt'],
    ].map(([name, title, type]) => ({
      name,
      type,
      interface: type === 'string' ? 'input' : 'integer',
      uiSchema: {
        type: type === 'string' ? 'string' : 'number',
        title: `{{t("${title}", { ns: "${namespace}" })}}`,
        'x-component': type === 'string' ? 'Input' : 'InputNumber',
      },
    })),
  ],
};
