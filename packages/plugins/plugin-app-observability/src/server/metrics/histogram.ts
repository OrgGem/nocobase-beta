import type { HistogramSnapshot } from '../contracts';

export const LATENCY_BOUNDARIES_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];
export const FIRST_BYTE_BOUNDARIES_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

export class BoundedHistogram {
  private count = 0;
  private sum = 0;
  private max = 0;
  private readonly buckets: number[];
  constructor(private readonly boundaries: readonly number[]) {
    this.buckets = new Array(boundaries.length + 1).fill(0);
  }
  observe(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.count += 1;
    this.sum += value;
    this.max = Math.max(this.max, value);
    const index = this.boundaries.findIndex((boundary) => value <= boundary);
    this.buckets[index === -1 ? this.boundaries.length : index] += 1;
  }
  snapshot(): HistogramSnapshot {
    return { count: this.count, sum: this.sum, max: this.max, buckets: [...this.buckets] };
  }
}

export function histogramQuantile(
  snapshot: HistogramSnapshot,
  boundaries: readonly number[],
  quantile: number,
): number | null {
  if (snapshot.count === 0) return null;
  const target = Math.max(1, Math.ceil(snapshot.count * quantile));
  let cumulative = 0;
  for (let index = 0; index < snapshot.buckets.length; index += 1) {
    cumulative += snapshot.buckets[index] ?? 0;
    if (cumulative >= target) return boundaries[index] ?? snapshot.max;
  }
  return snapshot.max;
}
