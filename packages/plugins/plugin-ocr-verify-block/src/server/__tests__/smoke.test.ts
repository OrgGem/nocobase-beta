import { createMockServer } from '@nocobase/test';
import PluginOcrVerifyBlockServer from '../plugin';

describe('OCR Verify Block plugin smoke', () => {
  let app;
  let agent;

  beforeEach(async () => {
    app = await createMockServer({
      plugins: ['nocobase', PluginOcrVerifyBlockServer],
      acl: false,
    });
    await app.install();

    const adminUser = await app.db.getRepository('users').findOne();
    agent = app.agent();
    if (adminUser) {
      await agent.login(adminUser);
    }
  });

  afterEach(async () => {
    await app?.destroy();
  });

  it('loads without starting the full app', async () => {
    expect(app).toBeTruthy();
  });

  it('can get settings', async () => {
    const res = await agent.resource('ocrVerifySettings').get();
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('pdfjsVersion');
    expect(res.body.data).toHaveProperty('callbackApiKeySet');
  });

  it('can save settings', async () => {
    const res = await agent.resource('ocrVerifySettings').save({
      values: {
        acceptStatus: 'custom_accepted',
        callbackUrl: 'https://example.com/callback',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.acceptStatus).toBe('custom_accepted');
    expect(res.body.data.callbackUrl).toBe('https://example.com/callback');
  });

  it('can get default mapping', async () => {
    const res = await agent.resource('ocrVerifyMappingProfiles').default();
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('default');
    expect(res.body.data.itemsPath).toBe('pages[].items[]');
  });

  it('can perform ocrVerify actions (saveDraft, accept, reject)', async () => {
    const collection = app.db.collection({
      name: 'invoices',
      fields: [
        { name: 'pdf', type: 'json' },
        { name: 'ocrData', type: 'json' },
        { name: 'status', type: 'string' },
      ],
    });
    await collection.sync();

    const record = await collection.repository.create({
      values: {
        pdf: [{ id: 1, url: 'https://example.com/test.pdf' }],
        ocrData: {
          pages: [
            {
              items: [{ id: '1', key: 'invoice_no', value: 'INV-001', confidence: 0.99 }],
            },
          ],
        },
        status: 'pending',
      },
    });

    // 1. Get Payload
    const getPayloadRes = await agent.resource('ocrVerify').getPayload({
      values: {
        collection: 'invoices',
        recordId: record.id,
        pdfField: 'pdf',
        jsonField: 'ocrData',
        statusField: 'status',
      },
    });
    expect(getPayloadRes.status).toBe(200);
    const payload = getPayloadRes.body.data || getPayloadRes.body;
    expect(String(payload.recordId)).toBe(String(record.id));
    expect(payload.pdfUrl).toBe('https://example.com/test.pdf');
    expect(payload.items.length).toBe(1);
    expect(payload.items[0].value).toBe('INV-001');

    // 2. Save Draft
    const saveDraftRes = await agent.resource('ocrVerify').saveDraft({
      values: {
        collection: 'invoices',
        recordId: record.id,
        jsonField: 'ocrData',
        data: {
          pages: [
            {
              items: [{ id: '1', key: 'invoice_no', value: 'INV-001-edited', confidence: 0.99 }],
            },
          ],
        },
      },
    });
    expect(saveDraftRes.status).toBe(200);
    const saveDraftBody = saveDraftRes.body.data || saveDraftRes.body;
    expect(saveDraftBody.ok).toBe(true);
    expect(saveDraftBody.data.pages[0].items[0].value).toBe('INV-001-edited');

    // Verify the record was updated in the DB
    const updatedRecord1 = await collection.repository.findOne({ filterByTk: record.id });
    expect(updatedRecord1.ocrData.pages[0].items[0].value).toBe('INV-001-edited');

    // 3. Accept
    const acceptRes = await agent.resource('ocrVerify').accept({
      values: {
        collection: 'invoices',
        recordId: record.id,
        jsonField: 'ocrData',
        statusField: 'status',
        data: {
          pages: [
            {
              items: [{ id: '1', key: 'invoice_no', value: 'INV-001-final', confidence: 1.0 }],
            },
          ],
        },
      },
    });
    expect(acceptRes.status).toBe(200);
    const acceptBody = acceptRes.body.data || acceptRes.body;
    expect(acceptBody.status).toBe('accepted');

    const updatedRecord2 = await collection.repository.findOne({ filterByTk: record.id });
    expect(updatedRecord2.status).toBe('accepted');
    expect(updatedRecord2.ocrData.pages[0].items[0].value).toBe('INV-001-final');

    // 4. Reject
    const rejectRes = await agent.resource('ocrVerify').reject({
      values: {
        collection: 'invoices',
        recordId: record.id,
        jsonField: 'ocrData',
        statusField: 'status',
      },
    });
    expect(rejectRes.status).toBe(200);
    const rejectBody = rejectRes.body.data || rejectRes.body;
    expect(rejectBody.status).toBe('rejected');

    const updatedRecord3 = await collection.repository.findOne({ filterByTk: record.id });
    expect(updatedRecord3.status).toBe('rejected');
  });
});
