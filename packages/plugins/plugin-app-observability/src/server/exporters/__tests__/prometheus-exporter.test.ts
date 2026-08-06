import { describe, expect, it } from 'vitest';

import { exportPrometheus } from '../prometheus-exporter';

describe('Prometheus exporter', () => {
  it('escapes labels and emits only bounded allowlisted labels', () => {
    const output = exportPrometheus({
      appName: 'main',
      nodeId: 'node-1',
      timestamp: 1,
      workerMode: 'web',
      activeUsers: 1,
      runtime: null,
      services: {
        one: {
          service: 'http',
          operation: '/a"b',
          streaming: false,
          attributes: { model: 'safe', userId: 'secret', requestId: 'secret' },
          inflight: 1,
          maxInflight: 2,
          requestCount: 3,
          successCount: 2,
          failureCount: 1,
          cancelledCount: 0,
          rejectedCount: 0,
          bytesIn: 0,
          bytesOut: 0,
          inputTokens: 0,
          outputTokens: 0,
          latency: { count: 1, sum: 10, max: 10, buckets: [0, 1] },
          firstByte: { count: 0, sum: 0, max: 0, buckets: [] },
        },
      },
    });
    expect(output).toContain('operation="/a\\"b"');
    expect(output).toContain('model="safe"');
    expect(output).not.toContain('secret');
    expect(output).toContain('nocobase_app_observability_requests_total');
  });
});
