// SPDX-License-Identifier: Apache-2.0

import * as crypto from 'crypto';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createMockServer, type MockServer } from '@nocobase/test';
import { JOB_STATUS } from '@nocobase/plugin-workflow';
import PluginDocumentUnderstandingServer from '../plugin';
import { DocumentUnderstandingWorkflowInstruction } from '../workflow/DocumentUnderstandingInstruction';

describe('Document Understanding du-rework Public Gateway & Built-in Business Engine', () => {
  let app: MockServer;
  let adminAgent: ReturnType<MockServer['agent']>;
  let anonAgent: ReturnType<MockServer['agent']>;
  let plugin: PluginDocumentUnderstandingServer;
  const mockLlmInvoke = vi.fn();

  beforeAll(async () => {
    app = await createMockServer({
      plugins: [
        'field-sort',
        'system-settings',
        'users',
        'auth',
        'acl',
        'data-source-manager',
        'data-source-main',
        'error-handler',
      ],
      acl: false,
    });

    // Attach mock @nocobase/plugin-ai aiManager to verify built-in AI & usage tracking
    (app as unknown as Record<string, unknown>).aiManager = {
      resolveModel: vi.fn().mockResolvedValue({ llmService: 'mock-openai', model: 'gpt-4o-mini' }),
      listAllEnabledModels: vi.fn().mockResolvedValue([
        {
          llmService: 'mock-openai',
          llmServiceTitle: 'Mock OpenAI',
          provider: 'openai',
          enabledModels: [{ label: 'gpt-4o-mini', value: 'gpt-4o-mini' }],
        },
      ]),
      getLLMService: vi.fn().mockResolvedValue({
        model: 'gpt-4o-mini',
        provider: {
          invoke: (...args: unknown[]) => mockLlmInvoke(...args),
        },
      }),
    };

    plugin = new PluginDocumentUnderstandingServer(app, { name: 'plugin-document-understanding' });
    await plugin.beforeLoad();
    await plugin.load();
    await app.db.sync();
    await plugin.afterStart();

    const adminUser = await app.db.getRepository('users').findOne();
    adminAgent = app.agent();
    anonAgent = app.agent();
    if (adminUser) {
      await adminAgent.login(adminUser);
    }
  }, 120_000);

  afterAll(async () => {
    await plugin?.beforeStop();
    await app?.destroy();
  });

  beforeEach(() => {
    mockLlmInvoke.mockReset();
  });

  it('exposes /api/du/v1/health and enforces fail-closed authentication on protected gateway routes', async () => {
    const healthRes = await anonAgent.get('/api/du/v1/health');
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.status).toBe('ok');
    expect(healthRes.body.businesses).toHaveLength(3);

    const unauthRes = await anonAgent.post('/api/du/v1/uploads').send({
      fileName: 'test.txt',
      sizeBytes: 4,
    });
    expect(unauthRes.status).toBe(401);
    expect(unauthRes.headers['content-type']).toContain('application/problem+json');
    expect(unauthRes.body.code).toBe('UNAUTHENTICATED');
  });

  it('issues scoped x-api-key credentials, enforces business ACL (403), and isolates tenants with 404', async () => {
    const keyARes = await adminAgent.resource('docUnderstanding').issueApiKey({
      values: {
        name: 'Tenant A Key',
        tenantId: 'tenant-a',
        allowedBusinesses: ['document-core'],
        allowedActions: ['*'],
      },
    });
    expect(keyARes.status).toBe(200);
    const tenantAKey: string = keyARes.body.data.rawKey;
    expect(tenantAKey.startsWith('du_live_')).toBe(true);

    const keyBRes = await adminAgent.resource('docUnderstanding').issueApiKey({
      values: {
        name: 'Tenant B Key',
        tenantId: 'tenant-b',
        allowedBusinesses: ['document-core'],
      },
    });
    const tenantBKey: string = keyBRes.body.data.rawKey;

    // Tenant A cannot call lc-checker (403 PERMISSION_DENIED)
    const deniedBiz = await anonAgent
      .post('/api/du/v1/businesses/lc-checker/actions/lc-checker')
      .set('x-api-key', tenantAKey)
      .send({ input: {} });
    expect(deniedBiz.status).toBe(403);
    expect(deniedBiz.body.code).toBe('PERMISSION_DENIED');

    // Tenant A creates an upload; Tenant B probing Tenant A's artifactId gets 404 NOT_FOUND
    const uploadInit = await anonAgent
      .post('/api/du/v1/uploads')
      .set('x-api-key', tenantAKey)
      .set('Idempotency-Key', 'idem-upload-tenant-a-1')
      .send({
        fileName: 'secret-a.txt',
        mimeType: 'text/plain',
        sizeBytes: 11,
      });
    expect(uploadInit.status).toBe(201);
    const artifactId: string = uploadInit.body.artifactId;

    // Idempotent replay with same metadata returns 200 replayed: true
    const replayInit = await anonAgent
      .post('/api/du/v1/uploads')
      .set('x-api-key', tenantAKey)
      .set('Idempotency-Key', 'idem-upload-tenant-a-1')
      .send({
        fileName: 'secret-a.txt',
        mimeType: 'text/plain',
        sizeBytes: 11,
      });
    expect(replayInit.status).toBe(200);
    expect(replayInit.body.replayed).toBe(true);
    expect(replayInit.body.artifactId).toBe(artifactId);

    // Tenant B attempting to upload or download Tenant A's artifact gets 404
    const crossTenantDownload = await anonAgent
      .get(`/api/du/v1/artifacts/${artifactId}/download`)
      .set('x-api-key', tenantBKey);
    expect(crossTenantDownload.status).toBe(404);
    expect(crossTenantDownload.body.code).toBe('NOT_FOUND');

    // Revoking Tenant B key immediately blocks access with 401
    await adminAgent.resource('docUnderstanding').revokeApiKey({ filterByTk: keyBRes.body.data.id });
    const afterRevoke = await anonAgent.get('/api/du/v1/operations').set('x-api-key', tenantBKey);
    expect(afterRevoke.status).toBe(401);
  });

  it('executes 2-step upload with SHA-256 check, DI-06 page selection, ingest:split, redact, and diff', async () => {
    const keyRes = await adminAgent.resource('docUnderstanding').issueApiKey({
      values: { name: 'Core Client', tenantId: 'tenant-core' },
    });
    const apiKey: string = keyRes.body.data.rawKey;

    const multiPageContent = Buffer.from('Page One Header\fPage Two Contract Body\fPage Three Appendix', 'utf8');
    const sha256 = crypto.createHash('sha256').update(multiPageContent).digest('hex');

    const initRes = await anonAgent
      .post('/api/v1/uploads')
      .set('x-api-key', apiKey)
      .send({ fileName: 'contract.txt', mimeType: 'text/plain', sizeBytes: multiPageContent.length });
    expect(initRes.status).toBe(201);
    const artId: string = initRes.body.artifactId;

    // Bad SHA-256 is rejected with 422 CHECKSUM_MISMATCH
    const badPut = await anonAgent
      .put(`/api/v1/uploads/${artId}/content`)
      .set('x-api-key', apiKey)
      .set('Content-Type', 'text/plain')
      .set('x-content-sha256', '0'.repeat(64))
      .send(multiPageContent);
    expect(badPut.status).toBe(422);
    expect(badPut.body.code).toBe('CHECKSUM_MISMATCH');

    // Valid SHA-256 transitions artifact to READY
    const okPut = await anonAgent
      .put(`/api/v1/uploads/${artId}/content`)
      .set('x-api-key', apiKey)
      .set('Content-Type', 'text/plain')
      .set('x-content-sha256', sha256)
      .send(multiPageContent);
    expect(okPut.status).toBe(201);
    expect(okPut.body.state).toBe('READY');

    // Submit ingest:parse with DI-06 documentSelection for pages 1-2 only
    const submitRes = await anonAgent
      .post('/api/v1/businesses/document-core/actions/ingest')
      .set('x-api-key', apiKey)
      .set('Idempotency-Key', 'op-ingest-pages-1-2')
      .send({
        input: { mode: 'parse', outputFormat: 'md' },
        artifacts: [{ artifactId: artId, role: 'input' }],
        documentSelection: {
          kind: 'requestSelection',
          schemaVersion: 1,
          mode: 'combined',
          artifactIds: [artId],
          pageSelections: [
            {
              artifactId: artId,
              selection: { kind: 'ranges', ranges: [{ from: 1, to: 2 }] },
            },
          ],
        },
      });
    expect(submitRes.status).toBe(202);
    const opId: string = submitRes.body.operationId;

    // Reusing Idempotency-Key with a DIFFERENT body returns 409 IDEMPOTENCY_CONFLICT
    const conflictRes = await anonAgent
      .post('/api/v1/businesses/document-core/actions/ingest')
      .set('x-api-key', apiKey)
      .set('Idempotency-Key', 'op-ingest-pages-1-2')
      .send({
        input: { mode: 'ocr' },
        artifacts: [{ artifactId: artId, role: 'input' }],
      });
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.code).toBe('IDEMPOTENCY_CONFLICT');

    // Wait for completion via ?wait=5
    const opView = await anonAgent.get(`/api/v1/operations/${opId}?wait=5`).set('x-api-key', apiKey);
    expect(opView.status).toBe(200);
    expect(opView.body.state).toBe('SUCCEEDED');
    expect(opView.body.documentInputCoverage.status).toBe('complete');

    // Fetch ResultEnvelope & download output JSON artifact
    const resultEnv = await anonAgent.get(`/api/v1/operations/${opId}/result`).set('x-api-key', apiKey);
    expect(resultEnv.status).toBe(200);
    expect(resultEnv.body.schemaVersion).toBe('1');
    const resultRef: string = resultEnv.body.data.resultRef;
    expect(resultRef.startsWith('artifact://')).toBe(true);

    const outArtifactId = resultRef.slice('artifact://'.length);
    const downloaded = await anonAgent.get(`/api/v1/artifacts/${outArtifactId}/download`).set('x-api-key', apiKey);
    expect(downloaded.status).toBe(200);
    expect(downloaded.body.version).toBe('document-core-result-v1');
    expect(downloaded.body.text).toContain('Page One Header');
    expect(downloaded.body.text).toContain('Page Two Contract Body');
    expect(downloaded.body.text).not.toContain('Page Three Appendix');

    // Test ingest:split creating multiple output artifacts
    const splitSubmit = await anonAgent
      .post('/api/v1/businesses/document-core/actions/ingest?sync=true')
      .set('x-api-key', apiKey)
      .send({
        input: { mode: 'split', pages: '1-1,2-3' },
        artifacts: [{ artifactId: artId, role: 'input' }],
      });
    expect(splitSubmit.status).toBe(202);
    const splitEnv = await anonAgent
      .get(`/api/v1/operations/${splitSubmit.body.operationId}/result`)
      .set('x-api-key', apiKey);
    expect(splitEnv.body.artifacts.filter((a: { role: string }) => a.role === 'output')).toHaveLength(3);

    // Test transform:redact PII masking
    const redactSubmit = await anonAgent
      .post('/api/v1/businesses/document-core/actions/transform?sync=true')
      .set('x-api-key', apiKey)
      .send({
        input: {
          variant: 'redact',
          text: 'Khách hàng Nguyễn Văn A, CCCD 001090012345, SĐT 0912345678.',
          redactPatterns: ['CCCD', 'PHONE_NUMBER'],
        },
      });
    const redactEnv = await anonAgent
      .get(`/api/v1/operations/${redactSubmit.body.operationId}/result`)
      .set('x-api-key', apiKey);
    const redactOutId = String(redactEnv.body.data.resultRef).slice('artifact://'.length);
    const redactPayload = await anonAgent.get(`/api/v1/artifacts/${redactOutId}/download`).set('x-api-key', apiKey);
    expect(redactPayload.body.data.transformedText).toBe('Khách hàng Nguyễn Văn A, CCCD [REDACTED], SĐT [REDACTED].');
  });

  it('handles disbursement HITL WAITING_INPUT -> CAS resume and lc-checker UCP 600 safety invariants', async () => {
    const keyRes = await adminAgent.resource('docUnderstanding').issueApiKey({
      values: { name: 'Bank Trade & Credit', tenantId: 'tenant-bank' },
    });
    const apiKey: string = keyRes.body.data.rawKey;

    // Upload sample document
    const docBuf = Buffer.from('Khế ước nhận nợ số tiền 2.000.000.000 VND, TK thụ hưởng 19034567890012.', 'utf8');
    const init = await anonAgent
      .post('/api/du/v1/uploads')
      .set('x-api-key', apiKey)
      .send({ fileName: 'khe-uoc.txt', mimeType: 'text/plain', sizeBytes: docBuf.length });
    await anonAgent
      .put(`/api/du/v1/uploads/${init.body.artifactId}/content`)
      .set('x-api-key', apiKey)
      .set('Content-Type', 'text/plain')
      .send(docBuf);

    // 1. Disbursement with requireApproval: true -> WAITING_INPUT -> CAS resume -> SUCCEEDED
    mockLlmInvoke
      .mockResolvedValueOnce({
        content: JSON.stringify({
          docType: 'promissory_note',
          extracted: { loanAmount: 2000000000, beneficiaryAccount: '19034567890012' },
        }),
        usage_metadata: { input_tokens: 120, output_tokens: 45 },
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          findings: [{ key: 'loanAmount', status: 'match', detail: 'Khớp 2 tỷ VND' }],
          report: '# BÁO CÁO ĐỐI CHIẾU HỒ SƠ GIẢI NGÂN',
        }),
        usage_metadata: { input_tokens: 200, output_tokens: 80 },
      });

    const disbSubmit = await anonAgent
      .post('/api/du/v1/businesses/document-core/actions/disbursement')
      .set('x-api-key', apiKey)
      .send({
        input: {
          requireApproval: true,
          referenceData: [{ key: 'loanAmount', expected: 2000000000 }],
        },
        artifacts: [{ artifactId: init.body.artifactId, role: 'input' }],
      });
    const disbOpId: string = disbSubmit.body.operationId;

    const pausedView = await anonAgent.get(`/api/du/v1/operations/${disbOpId}?wait=5`).set('x-api-key', apiKey);
    expect(pausedView.body.state).toBe('WAITING_INPUT');
    expect(pausedView.body.wait.waitId).toBe('approval-wait');

    // Wrong expectedStateVersion is rejected with 409 STATE_CONFLICT
    const badResume = await anonAgent
      .post(`/api/du/v1/operations/${disbOpId}/resume`)
      .set('x-api-key', apiKey)
      .send({
        waitId: 'approval-wait',
        expectedStateVersion: 999,
        input: { approved: true },
      });
    expect(badResume.status).toBe(409);

    // Valid CAS resume completes the workflow
    const okResume = await anonAgent
      .post(`/api/du/v1/operations/${disbOpId}/resume`)
      .set('x-api-key', apiKey)
      .send({
        waitId: 'approval-wait',
        expectedStateVersion: pausedView.body.stateVersion,
        input: { approved: true, approver: 'checker@bank.vn', note: 'Đồng ý' },
      });
    expect(okResume.status).toBe(202);

    const doneView = await anonAgent.get(`/api/du/v1/operations/${disbOpId}?wait=5`).set('x-api-key', apiKey);
    expect(doneView.body.state).toBe('SUCCEEDED');

    // 2. lc-checker: refuses COMPLIANT when outstandingVisualChecks remain & normalizes unregistered ruleId
    mockLlmInvoke
      .mockResolvedValueOnce({
        content: JSON.stringify({
          documentsPresent: ['MT700', 'BILL_OF_LADING'],
          documentsMissing: [],
          // Requests visual check on non-signed text -> will produce an outstandingVisualCheck!
          visualRequests: [
            { document: 'khe-uoc.txt', check: 'Verify manual carrier endorsement', ruleId: 'UCP600-ART20-A-I' },
          ],
        }),
        usage_metadata: { input_tokens: 300, output_tokens: 90 },
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          // Model tries to say COMPLIANT and invents a fake rule ID — engine must guard both!
          verdict: 'COMPLIANT',
          discrepancies: [
            {
              id: 'DISC-01',
              severity: 'MINOR',
              document: 'khe-uoc.txt',
              field: 'Endorsement',
              issue: 'Cần kiểm tra ký hậu',
              ruleId: 'FAKE-NONEXISTENT-RULE',
            },
          ],
          summary: 'Kiểm tra sơ bộ.',
          report: '# BÁO CÁO L/C',
        }),
        usage_metadata: { input_tokens: 400, output_tokens: 110 },
      });

    const lcSubmit = await anonAgent
      .post('/api/du/v1/businesses/lc-checker/actions/lc-checker?sync=true')
      .set('x-api-key', apiKey)
      .send({
        input: { ruleSetVersion: 'ucp600-isbp821-v1' },
        artifacts: [{ artifactId: init.body.artifactId, role: 'input' }],
      });
    const lcEnv = await anonAgent
      .get(`/api/du/v1/operations/${lcSubmit.body.operationId}/result`)
      .set('x-api-key', apiKey);
    const lcOutId = String(lcEnv.body.data.resultRef).slice('artifact://'.length);
    const lcPayload = await anonAgent.get(`/api/du/v1/artifacts/${lcOutId}/download`).set('x-api-key', apiKey);

    expect(lcPayload.body.resultVersion).toBe('lc-checker-result-v1');
    expect(lcPayload.body.verdict).toBe('DISCREPANT');
    expect(lcPayload.body.humanSignOffRequired).toBe(true);
    expect(lcPayload.body.outstandingVisualChecks.length).toBeGreaterThan(0);
    expect(lcPayload.body.discrepancies[0].ruleId).toBe('UCP600-ART14-A');

    // Usage summary reflects token consumption
    const now = new Date();
    const from = new Date(now.getTime() - 3600_000).toISOString();
    const to = new Date(now.getTime() + 3600_000).toISOString();
    const usageRes = await anonAgent
      .get(`/api/du/v1/usage/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set('x-api-key', apiKey);
    expect(usageRes.status).toBe(200);
    expect(usageRes.body.totalOperations).toBeGreaterThanOrEqual(2);
    expect(usageRes.body.inputTokens).toBeGreaterThan(0);
  });

  it('executes the NocoBase workflow instruction node and returns structured variables', async () => {
    const sampleDir = resolve(process.cwd(), 'storage', 'uploads', 'du-wf-test');
    const sampleFile = resolve(sampleDir, 'memo.txt');
    mkdirSync(sampleDir, { recursive: true });
    writeFileSync(sampleFile, 'Hồ sơ của khách hàng SĐT 0987654321 và CCCD 012345678901.');

    try {
      const instruction = new DocumentUnderstandingWorkflowInstruction({ app } as never);
      const node = {
        id: 101,
        key: 'du_node_1',
        config: {
          mode: 'business_action',
          businessId: 'document-core',
          action: 'transform',
          variant: 'redact',
          files: 'uploads/du-wf-test/memo.txt',
          inputJson: { redactPatterns: ['CCCD', 'PHONE_NUMBER'] },
        },
      };
      const processor = {
        getParsedValue: (v: unknown) => v,
        isInstructionSync: () => true,
      };

      const jobResult = await instruction.run(node as never, null as never, processor as never);
      expect(jobResult?.status).toBe(JOB_STATUS.RESOLVED);
      const resultObj = jobResult?.result as Record<string, unknown>;
      expect(resultObj.state).toBe('SUCCEEDED');
      expect((resultObj.data as Record<string, unknown>).transformedText).toBe(
        'Hồ sơ của khách hàng SĐT [REDACTED] và CCCD [REDACTED].',
      );
    } finally {
      rmSync(sampleDir, { recursive: true, force: true });
    }
  });
});
