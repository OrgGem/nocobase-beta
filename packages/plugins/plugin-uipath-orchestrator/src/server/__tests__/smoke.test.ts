import { createMockServer } from '@nocobase/test';
import { createHmac } from 'crypto';
import { UiPathWebhookVerifier } from '../services/UiPathWebhookVerifier';
import { UiPathApiClient } from '../services/UiPathApiClient';

describe('UiPath Orchestrator plugin', () => {
  let app;

  afterEach(async () => {
    await app?.destroy();
  });

  it('loads with mock server', async () => {
    app = await createMockServer({
      plugins: ['nocobase', 'uipath-orchestrator'],
    });

    expect(app).toBeTruthy();
  });
});

describe('UiPathWebhookVerifier', () => {
  it('verifies valid HMAC-SHA256 signature', () => {
    const secret = 'test-secret';
    const rawBody = JSON.stringify({ Type: 'job.faulted', EventId: 'evt-1' });
    const signature = createHmac('sha256', secret).update(rawBody).digest('base64');

    expect(UiPathWebhookVerifier.verify(secret, signature, rawBody)).toBe(true);
  });

  it('rejects invalid signature', () => {
    expect(UiPathWebhookVerifier.verify('secret', 'invalid-sig', '{}')).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(UiPathWebhookVerifier.verify('', 'sig', '{}')).toBe(false);
    expect(UiPathWebhookVerifier.verify('sec', '', '{}')).toBe(false);
  });

  it('parses event type from payload', () => {
    expect(UiPathWebhookVerifier.parseEventType({ Type: 'job.faulted' })).toBe('job.faulted');
    expect(UiPathWebhookVerifier.parseEventType({ type: 'queueItem.added' })).toBe('queueItem.added');
    expect(UiPathWebhookVerifier.parseEventType({})).toBe('unknown');
  });

  it('extracts entity ID from job webhook payload', () => {
    const payload = { Type: 'job.faulted', Job: { Key: 'job-key-123', Id: 456 } };
    expect(UiPathWebhookVerifier.extractEntityId(payload)).toBe('job-key-123');
  });

  it('extracts entity ID from queue item payload', () => {
    const payload = { Type: 'queueItem.transactionFailed', QueueItem: { Id: 789 } };
    expect(UiPathWebhookVerifier.extractEntityId(payload)).toBe('789');
  });
});

describe('UiPathApiClient OData query builder', () => {
  it('builds basic OData params', () => {
    const params = UiPathApiClient.buildODataParams({ $top: 10, $skip: 20, $count: true });
    expect(params.get('$top')).toBe('10');
    expect(params.get('$skip')).toBe('20');
    expect(params.get('$count')).toBe('true');
  });

  it('handles short-key aliases', () => {
    const params = UiPathApiClient.buildODataParams({ top: 5, filter: "State eq 'Faulted'" });
    expect(params.get('$top')).toBe('5');
    expect(params.get('$filter')).toBe("State eq 'Faulted'");
  });

  it('passes through non-OData params', () => {
    const params = UiPathApiClient.buildODataParams({ custom: 'value', $top: 10 });
    expect(params.get('custom')).toBe('value');
    expect(params.get('$top')).toBe('10');
  });

  it('returns empty params for null query', () => {
    const params = UiPathApiClient.buildODataParams();
    expect(params.toString()).toBe('');
  });
});
