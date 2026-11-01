import { createFilePreviewWorkContext } from '../filePreviewContext';

describe('V2 file preview work context', () => {
  it('preserves exact attachment identifiers and normalizes storage metadata for the server parser', () => {
    const context = createFilePreviewWorkContext({
      id: '9007199254740993',
      name: 'report.pdf',
      url: '/uploads/report.pdf',
      storage: { id: 2, type: 'sftp-private', name: 'private-documents' },
    });
    expect(context.type).toBe('file-preview');
    expect(context.uid).toBe('file-preview:9007199254740993');
    expect(context.title).toBe('report.pdf');
    expect(context.content).toMatchObject({
      source: 'plugin-file-preview-auth',
      file: {
        id: '9007199254740993',
        filename: 'report.pdf',
        storageId: 2,
        storageType: 'sftp-private',
        storageName: 'private-documents',
      },
    });
  });

  it('preserves explicit storage fields and tolerates incomplete preview records', () => {
    expect(
      createFilePreviewWorkContext({ title: 'report', extname: '.docx', storageId: 0, storage: { id: 2 } }),
    ).toMatchObject({ title: 'report.docx', content: { file: { storageId: 0 } } });
    expect(createFilePreviewWorkContext(null)).toMatchObject({ uid: 'file-preview:file', title: 'file' });
  });
});
