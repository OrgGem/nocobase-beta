/**
 * Collection: workerQueueMappings
 *
 * Maps queue names to worker stacks (orchestratorStacks).
 * When a stack has assigned queues, the orchestrator adapter sets
 * WORKER_MODE=<comma-separated-queue-names> on new containers.
 *
 * Explicit orchestratorStacks.workerMode takes precedence. If no explicit
 * mode exists, mappings can still provide WORKER_MODE for legacy stacks.
 */
export default {
  name: 'workerQueueMappings',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    {
      name: 'queueName',
      type: 'string',
      unique: true,
      interface: 'input',
      uiSchema: {
        title: 'Queue Name',
        'x-component': 'Input',
        required: true,
      },
    },
    {
      name: 'label',
      type: 'string',
      interface: 'input',
      uiSchema: {
        title: 'Label',
        'x-component': 'Input',
        description: 'Human-readable display name',
      },
    },
    {
      name: 'description',
      type: 'text',
      interface: 'textarea',
      uiSchema: {
        title: 'Description',
        'x-component': 'Input.TextArea',
      },
    },
    {
      name: 'type',
      type: 'string',
      interface: 'select',
      defaultValue: 'event-queue',
      uiSchema: {
        title: 'Source Type',
        'x-component': 'Select',
        enum: [
          { value: 'event-queue', label: 'EventQueue' },
          { value: 'redis-list', label: 'Redis List' },
        ],
      },
    },
    {
      name: 'stackId',
      type: 'integer',
      interface: 'select',
      uiSchema: {
        title: 'Assigned Stack',
        'x-component': 'Select',
        'x-component-props': {
          allowClear: true,
          placeholder: 'Unassigned (fallback only)',
        },
      },
    },
    {
      name: 'enabled',
      type: 'boolean',
      defaultValue: true,
      interface: 'checkbox',
      uiSchema: {
        title: 'Enabled',
        'x-component': 'Checkbox',
      },
    },
  ],
};
