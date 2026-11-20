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

// Client metadata for the virtual workflowGitReview approval task resource so v1 List.Decorator resolves the collection.
export const reviewApprovalCollection = {
  name: 'workflowGitReview',
  title: `{{t("Git review approvals", { ns: "${namespace}" })}}`,
  hidden: true,
  filterTargetKey: 'id',
  titleField: 'title',
  fields: [
    {
      name: 'id',
      type: 'integer',
      primaryKey: true,
      interface: 'id',
      uiSchema: { type: 'number', title: '{{t("ID")}}', 'x-component': 'InputNumber' },
    },
    {
      name: 'title',
      type: 'string',
      interface: 'input',
      uiSchema: {
        type: 'string',
        title: `{{t("Review approval", { ns: "${namespace}" })}}`,
        'x-component': 'Input',
      },
    },
    {
      name: 'executionId',
      type: 'bigInt',
      interface: 'integer',
      uiSchema: {
        type: 'number',
        title: `{{t("Execution ID", { ns: "${namespace}" })}}`,
        'x-component': 'InputNumber',
      },
    },
    {
      name: 'reviewId',
      type: 'integer',
      interface: 'integer',
      uiSchema: {
        type: 'number',
        title: `{{t("Review ID", { ns: "${namespace}" })}}`,
        'x-component': 'InputNumber',
      },
    },
  ],
};
