import { buildContentDisposition } from '../content-disposition';

describe('buildContentDisposition', () => {
  it('emits both ASCII fallback and RFC 5987 UTF-8 form', () => {
    const header = buildContentDisposition('report.pdf', 'attachment');
    expect(header).toEqual(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  });

  it('encodes non-ASCII filenames in the UTF-8 form while sanitizing the fallback', () => {
    const header = buildContentDisposition('báo cáo tài chính.pdf', 'attachment');
    expect(header).toContain(`filename="b_o c_o t_i ch_nh.pdf"`);
    expect(header).toContain(`filename*=UTF-8''b%C3%A1o%20c%C3%A1o`);
  });

  it('strips quotes and backslashes from the ASCII fallback to prevent header injection', () => {
    const header = buildContentDisposition('evil".txt', 'attachment');
    expect(header).not.toContain(`filename="evil"`);
    expect(header).toContain(`filename="evil_.txt"`);
  });

  it('percent-encodes RFC 5987 special characters that encodeURIComponent leaves alone', () => {
    const header = buildContentDisposition("file'*().txt", 'inline');
    expect(header).toContain(`filename*=UTF-8''file%27%2A%28%29.txt`);
    expect(header.startsWith('inline;')).toBe(true);
  });

  it('falls back to "file" for empty names', () => {
    const header = buildContentDisposition('', 'attachment');
    expect(header).toContain('filename="file"');
  });
});
