import type { OcrPoint, OcrRect } from '../../shared/types';

export function getOverlayPoints(
  item: { rect?: OcrRect; points?: OcrPoint[] },
  width: number,
  height: number,
  scale: number,
): string {
  if (item.points?.length) {
    return item.points
      .map(({ x, y }) => `${x <= 1 ? x * width : x * scale},${y <= 1 ? y * height : y * scale}`)
      .join(' ');
  }
  const rect = item.rect;
  if (!rect) return '';
  const factorX = rect.unit === 'normalized' ? width : scale;
  const factorY = rect.unit === 'normalized' ? height : scale;
  const x = rect.x * factorX,
    y = rect.y * factorY;
  const right = x + rect.width * factorX,
    bottom = y + rect.height * factorY;
  return `${x},${y} ${right},${y} ${right},${bottom} ${x},${bottom}`;
}
