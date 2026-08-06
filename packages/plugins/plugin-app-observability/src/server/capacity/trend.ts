export function linearTrend(points: Array<{ timestamp: number; value: number }>, threshold: number): number | null {
  if (points.length < 3) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const elapsed = last.timestamp - first.timestamp;
  const slope = elapsed > 0 ? (last.value - first.value) / elapsed : 0;
  if (last.value >= threshold) return last.timestamp;
  return slope > 0 ? last.timestamp + (threshold - last.value) / slope : null;
}
