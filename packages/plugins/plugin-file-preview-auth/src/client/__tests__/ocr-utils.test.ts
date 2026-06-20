import {
  extractOcrStatusRecord,
  getOcrAttachmentId,
  isOcrCapableCollection,
  isOcrCompleteStatus,
  normalizeOcrAttachmentId,
} from '../index';

describe('file preview OCR client utils', () => {
  describe('normalizeOcrAttachmentId', () => {
    it('accepts numeric attachment ids', () => {
      expect(normalizeOcrAttachmentId(12)).toBe(12);
      expect(normalizeOcrAttachmentId('12')).toBe('12');
      expect(normalizeOcrAttachmentId(' 12 ')).toBe('12');
    });

    it('rejects URLs and upload-only ids', () => {
      expect(normalizeOcrAttachmentId('http://localhost/storage/uploads/test.pdf')).toBeNull();
      expect(normalizeOcrAttachmentId('/storage/uploads/test.pdf')).toBeNull();
      expect(normalizeOcrAttachmentId('rc-upload-1710000000000-1')).toBeNull();
    });
  });

  describe('getOcrAttachmentId', () => {
    it('uses response.id when file.id is a storage URL', () => {
      expect(
        getOcrAttachmentId({
          id: 'http://localhost/storage/uploads/yyyy-test%20(1)-lcqadd.pdf',
          uid: 'rc-upload-1',
          response: {
            id: 42,
          },
        }),
      ).toBe(42);
    });

    it('falls back to a numeric uid for persisted attachment records', () => {
      expect(
        getOcrAttachmentId({
          id: '/storage/uploads/yyyy-test.pdf',
          uid: '88',
        }),
      ).toBe('88');
    });
  });

  describe('isOcrCapableCollection', () => {
    it('allows attachments and collection-less records', () => {
      expect(isOcrCapableCollection({ id: 1 })).toBe(true);
      expect(isOcrCapableCollection({ id: 1, collectionName: 'attachments' })).toBe(true);
      expect(isOcrCapableCollection({ id: 1, collectionName: '' })).toBe(true);
    });

    it('rejects non-attachment collections like aiFiles', () => {
      expect(isOcrCapableCollection({ id: 1, collectionName: 'aiFiles' })).toBe(false);
    });
  });

  describe('isOcrCompleteStatus', () => {
    it('only treats result statuses as completed', () => {
      expect(isOcrCompleteStatus('waiting-verify')).toBe(true);
      expect(isOcrCompleteStatus('success')).toBe(true);
      expect(isOcrCompleteStatus('no-ocr')).toBe(false);
      expect(isOcrCompleteStatus('pending-ocr')).toBe(false);
      expect(isOcrCompleteStatus('failed')).toBe(false);
    });
  });

  describe('extractOcrStatusRecord', () => {
    it('unwraps NocoBase double data responses', () => {
      const record = extractOcrStatusRecord({
        data: {
          data: {
            id: 4,
            attachmentId: 57,
            status: 'waiting-verify',
            data: { pages: [] },
            error: null,
          },
        },
      });

      expect(record?.id).toBe(4);
      expect(record?.attachmentId).toBe(57);
      expect(record?.status).toBe('waiting-verify');
    });

    it('unwraps action responses with ok and data', () => {
      const record = extractOcrStatusRecord({
        data: {
          ok: true,
          data: {
            id: 5,
            status: 'pending-ocr',
          },
        },
      });

      expect(record?.id).toBe(5);
      expect(record?.status).toBe('pending-ocr');
    });
  });
});
