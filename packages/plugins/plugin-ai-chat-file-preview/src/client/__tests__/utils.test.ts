import {
  stripFilenameNoise,
  extractFilenameFromText,
  getDisplayNameCandidates,
  isKnownFileUrl,
} from '../ChatFilePreviewProvider';

describe('AI Chat File Preview client utils', () => {
  describe('stripFilenameNoise', () => {
    it('should strip quotes and braces', () => {
      expect(stripFilenameNoise('"test.docx"')).toBe('test.docx');
      expect(stripFilenameNoise("'test.pdf'")).toBe('test.pdf');
      expect(stripFilenameNoise('(test.xlsx)')).toBe('test.xlsx');
      expect(stripFilenameNoise('[test.csv]')).toBe('test.csv');
      expect(stripFilenameNoise('  test.txt  ')).toBe('test.txt');
    });

    it('should handle clean strings without noise', () => {
      expect(stripFilenameNoise('clean_name.doc')).toBe('clean_name.doc');
    });
  });

  describe('extractFilenameFromText', () => {
    it('should extract files from paths or text content', () => {
      expect(extractFilenameFromText('Some text with a file name test.docx inside it')).toBe('test.docx');
      expect(extractFilenameFromText('/path/to/my-sheet.xlsx')).toBe('/path/to/my-sheet.xlsx');
      expect(extractFilenameFromText('download "data.csv"')).toBe('data.csv');
    });

    it('should fall back to cleaned text when no matching extension', () => {
      expect(extractFilenameFromText('unregistered_extension.abc')).toBe('unregistered_extension.abc');
    });
  });

  describe('getDisplayNameCandidates', () => {
    it('should return candidate names for matching', () => {
      const candidates = getDisplayNameCandidates('  "report.xlsx" ');
      expect(candidates).toContain('report.xlsx');
    });
  });

  describe('isKnownFileUrl', () => {
    it('should identify system file urls', () => {
      expect(isKnownFileUrl('/api/attachments/123')).toBe(true);
      expect(isKnownFileUrl('/api/files/download/abc')).toBe(true);
      expect(isKnownFileUrl('https://my-bucket.s3.amazonaws.com/file.pdf')).toBe(true);
    });

    it('should return false for unrelated urls', () => {
      expect(isKnownFileUrl('https://google.com')).toBe(false);
      expect(isKnownFileUrl('')).toBe(false);
      expect(isKnownFileUrl(undefined)).toBe(false);
    });
  });
});
