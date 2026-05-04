/**
 * Plugin settings stored in DB — configurable via NocoBase admin UI.
 * Replaces env-var-only configuration for orchestrator adapter selection.
 */
export default {
  name: 'orchestratorSettings',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    {
      name: 'adapterType',
      type: 'string',
      defaultValue: 'none',
      interface: 'select',
      uiSchema: {
        title: 'Orchestrator Adapter',
        'x-component': 'Select',
        enum: [
          { value: 'none', label: 'Disabled' },
          { value: 'docker', label: 'Docker (socket)' },
          { value: 'kubernetes', label: 'Kubernetes (API)' },
        ],
      },
    },
    // Docker settings
    {
      name: 'dockerSocketPath',
      type: 'string',
      defaultValue: '/var/run/docker.sock',
      interface: 'input',
      uiSchema: { title: 'Docker Socket Path', 'x-component': 'Input' },
    },
    {
      name: 'dockerHost',
      type: 'string',
      interface: 'input',
      uiSchema: {
        title: 'Docker Host (TCP)',
        description: 'Optional. Use instead of socket, e.g. tcp://192.168.1.10:2376',
        'x-component': 'Input',
      },
    },
    // K8s settings
    {
      name: 'k8sNamespace',
      type: 'string',
      defaultValue: 'nocobase',
      interface: 'input',
      uiSchema: { title: 'Kubernetes Namespace', 'x-component': 'Input' },
    },
    {
      name: 'k8sKubeconfig',
      type: 'text',
      interface: 'textarea',
      uiSchema: {
        title: 'Kubeconfig Path',
        description: 'Paste kubeconfig YAML or enter a file path. Leave empty to use in-cluster ServiceAccount',
        'x-component': 'Input.TextArea',
      },
    },
    // Worker-specific label filter
    {
      name: 'workerLabelSelector',
      type: 'string',
      defaultValue: 'role=worker',
      interface: 'input',
      uiSchema: {
        title: 'Worker Label Selector',
        description: 'Only manage containers/pods matching this label',
        'x-component': 'Input',
      },
    },
  ],
};
