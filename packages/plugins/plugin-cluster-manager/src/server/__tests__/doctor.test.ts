import { createMockServer, MockServer } from '@nocobase/test';
import PluginClusterManagerServer from '../plugin';

describe('plugin-cluster-manager doctor', () => {
  let app: MockServer;

  beforeEach(async () => {
    app = await createMockServer({
      plugins: ['error-handler', PluginClusterManagerServer],
      acl: false,
    });
  });

  afterEach(async () => {
    await app?.destroy();
  });

  it('runs one diagnostic session at a time and produces a downloadable report', async () => {
    const agent = app.agent();

    const started = await agent.resource('clusterManagerDoctor').start({
      values: { durationMs: 10000 },
    });
    expect(started.status).toBe(200);
    expect(started.body.data.status).toBe('running');
    expect(started.body.data.runId).toBeTruthy();

    const rejected = await agent.resource('clusterManagerDoctor').start({
      values: { durationMs: 10000 },
    });
    expect(rejected.status).toBe(409);

    const stopped = await agent.resource('clusterManagerDoctor').stop({
      values: { runId: started.body.data.runId },
    });
    expect(stopped.status).toBe(200);
    expect(stopped.body.data.status).toBe('finished');
    expect(stopped.body.data.report.summary.nodes).toBeGreaterThan(0);
    expect(stopped.body.data.report.runId).toBe(started.body.data.runId);

    const report = await agent.resource('clusterManagerDoctor').report({
      runId: started.body.data.runId,
    });
    expect(report.status).toBe(200);
    expect(report.body.data.report.summary).toBeTruthy();

    const download = await agent.resource('clusterManagerDoctor').download({
      runId: started.body.data.runId,
    });
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/json');
  });
});
