import { getOverlayPoints } from '../components/pdfGeometry';
import { getPdfSource } from '../components/pdfSource';

describe('V2 OCR PDF preview', () => {
  it('scales rectangle coordinates once and expands normalized coordinates to the rendered page size', () => {
    expect(getOverlayPoints({ rect: { x: 10, y: 20, width: 30, height: 40, unit: 'point' } }, 500, 1000, 2)).toBe(
      '20,40 80,40 80,120 20,120',
    );
    expect(
      getOverlayPoints({ rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4, unit: 'normalized' } }, 500, 1000, 2),
    ).toBe('50,200 200,200 200,600 50,600');
  });

  it('preserves point polygons and omits overlays for OCR items without coordinates', () => {
    expect(
      getOverlayPoints(
        {
          points: [
            { x: 0.1, y: 0.2 },
            { x: 0.3, y: 0.4 },
          ],
        },
        500,
        1000,
        2,
      ),
    ).toBe('50,200 150,400');
    expect(getOverlayPoints({}, 500, 1000, 2)).toBe('');
  });

  it('sends the current auth headers to local attachments only', () => {
    const headers = { Authorization: 'Bearer test-token', 'X-Role': 'viewer' };
    expect(getPdfSource('/api/filePreviewAuth:download?id=1', 'https://example.test', headers)).toEqual({
      url: 'https://example.test/api/filePreviewAuth:download?id=1',
      httpHeaders: headers,
      withCredentials: true,
    });
    expect(getPdfSource('https://files.example.test/a.pdf', 'https://example.test', headers)).toEqual({
      url: 'https://files.example.test/a.pdf',
      httpHeaders: undefined,
      withCredentials: false,
    });
  });
});
