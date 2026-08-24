import { defineCollection } from '@nocobase/database';

/**
 * Singleton runtime settings for plugin-api-manager. Exactly one row is kept.
 *
 * Values stored here are the runtime-configurable surface for the gateway's
 * capacity guard and circuit breaker. Precedence is:
 *
 *   process.env (when set) > settings row (when set) > built-in default
 *
 * so a deployment can still override any field through the documented env vars.
 */
export default defineCollection({
  name: 'apiManagerSettings',
  title: 'API Manager Settings',
  fields: [
    {
      type: 'integer',
      name: 'maxConcurrentRequests',
      interface: 'inputNumber',
      uiSchema: {
        title: 'Max Concurrent Requests',
        type: 'number',
        'x-component': 'InputNumber',
      },
    },
    {
      type: 'bigInt',
      name: 'maxTotalBytes',
      interface: 'inputNumber',
      uiSchema: {
        title: 'Max Total Bytes',
        type: 'number',
        'x-component': 'InputNumber',
      },
    },
    {
      type: 'bigInt',
      name: 'maxRequestBytes',
      interface: 'inputNumber',
      uiSchema: {
        title: 'Max Request Bytes',
        type: 'number',
        'x-component': 'InputNumber',
      },
    },
    {
      type: 'boolean',
      name: 'queueEnabled',
      interface: 'checkbox',
      uiSchema: { title: 'Queue Enabled', type: 'boolean', 'x-component': 'Checkbox' },
    },
    {
      type: 'integer',
      name: 'queueSize',
      interface: 'inputNumber',
      uiSchema: { title: 'Queue Size', type: 'number', 'x-component': 'InputNumber' },
    },
    {
      type: 'integer',
      name: 'queueTimeoutMs',
      interface: 'inputNumber',
      uiSchema: { title: 'Queue Timeout (ms)', type: 'number', 'x-component': 'InputNumber' },
    },
    {
      type: 'boolean',
      name: 'circuitBreakerEnabled',
      interface: 'checkbox',
      uiSchema: {
        title: 'Circuit Breaker Enabled',
        type: 'boolean',
        'x-component': 'Checkbox',
      },
    },
    {
      type: 'integer',
      name: 'circuitBreakerFailureThreshold',
      interface: 'inputNumber',
      uiSchema: {
        title: 'Failure Threshold',
        type: 'number',
        'x-component': 'InputNumber',
      },
    },
    {
      type: 'integer',
      name: 'circuitBreakerOpenDurationMs',
      interface: 'inputNumber',
      uiSchema: {
        title: 'Open Duration (ms)',
        type: 'number',
        'x-component': 'InputNumber',
      },
    },
    {
      type: 'boolean',
      name: 'circuitBreakerCountServerErrors',
      interface: 'checkbox',
      uiSchema: {
        title: 'Count Server Errors',
        type: 'boolean',
        'x-component': 'Checkbox',
      },
    },
  ],
});
