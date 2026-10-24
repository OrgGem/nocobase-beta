import { getOcrStatus, loadVerification, resolveVerificationInput, submitVerification } from '../verification';

const input = {
  dataSource: 'main',
  collection: 'invoices',
  recordId: '9007199254740993',
  pdfField: 'pdf',
  jsonField: 'ocrData',
  statusField: 'status',
  categoryId: 4,
};

describe('V2 OCR verification context', () => {
  it('uses the actual collection filter key and ignores stale manual values in current-record mode', () => {
    const record = { id: 1, invoiceKey: '9007199254740993' };
    const result = resolveVerificationInput(
      { ...input, sourceMode: 'currentRecord', recordId: 'stale' },
      {
        record,
        collection: { name: 'invoices', dataSourceKey: 'main', getFilterByTK: (value) => value.invoiceKey },
      },
    );
    expect(result).toMatchObject({ ...input, recordId: '9007199254740993', mappingProfileName: 'default' });
  });

  it('isolates manual mode and retains persisted manual configurations without a sourceMode', () => {
    const current = { record: { id: 5 }, collection: { name: 'other' } };
    expect(resolveVerificationInput({ ...input, sourceMode: 'manualRecord' }, current)).toMatchObject(input);
    expect(resolveVerificationInput(input, current)).toMatchObject(input);
    expect(resolveVerificationInput({ sourceMode: 'manualRecord' }, current).recordId).toBeUndefined();
  });

  it('uses popup input args when no record model is present, without guessing a key for another collection', () => {
    const context = { inputArgs: { collectionName: 'invoices', dataSourceKey: 'main', filterByTk: 'external-key' } };
    expect(resolveVerificationInput({}, context)).toMatchObject({ collection: 'invoices', recordId: 'external-key' });
    expect(resolveVerificationInput({ collection: 'other' }, context).recordId).toBeUndefined();
  });

  it('preserves external datasource identity and rejects composite keys instead of using an unrelated id', () => {
    const result = resolveVerificationInput(
      {},
      {
        record: { id: 1 },
        collection: { name: 'invoices', dataSourceKey: 'external', getFilterByTK: () => ({ tenant: 1, id: 1 }) },
      },
    );
    expect(result.dataSource).toBe('external');
    expect(result.recordId).toBeUndefined();
  });
});

describe('V2 OCR API payloads', () => {
  it('loads settings and verification payload with the existing action envelopes', async () => {
    const payload = {
      data: { data: 'document field named data' },
      items: [{ id: '1', key: 'invoice', value: 'INV-1' }],
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { data: { pdfjsCdnUrl: 'module' } } })
      .mockResolvedValueOnce({ data: { data: payload } });
    const result = await loadVerification({ request }, input);
    expect(request.mock.calls[1][0]).toMatchObject({ url: 'ocrVerify:getPayload', method: 'post', data: input });
    expect(result.payload).toBe(payload);
  });

  it.each(['saveDraft', 'accept', 'reject'] as const)(
    'preserves the edited document and item values for %s',
    async (action) => {
      const document = { pages: [{ items: [] }] },
        items = [{ id: '1', key: 'total', value: 'changed' }];
      const response = { data: document, items };
      const request = vi.fn().mockResolvedValue({ data: { data: response } });
      expect(await submitVerification({ request }, action, input, document, items)).toBe(response);
      expect(request).toHaveBeenCalledWith({
        url: `ocrVerify:${action}`,
        method: 'post',
        data: { ...input, data: document, items },
      });
    },
  );

  it('sends the attachmentId in the body and reads the nested file-preview status envelope', async () => {
    const status = { status: 'waiting-verify', error: null, data: { pages: [] } };
    const request = vi.fn().mockResolvedValue({ data: { data: { data: status } } });
    expect(await getOcrStatus({ request }, '9007199254740993')).toBe(status);
    expect(request).toHaveBeenCalledWith({
      url: 'filePreviewAuth:getOcrStatus',
      method: 'post',
      data: { attachmentId: '9007199254740993' },
    });
  });
});
