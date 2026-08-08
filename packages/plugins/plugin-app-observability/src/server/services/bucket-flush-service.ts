import type { ObservabilityBucket } from './bucket-aggregator';
import { BucketAggregator } from './bucket-aggregator';
interface BucketRepository {
  create(options: { values: Record<string, unknown> }): Promise<unknown>;
}
export class BucketFlushService {
  private flushing: Promise<number> | null = null;
  private pending: ObservabilityBucket[] = [];
  constructor(
    private readonly aggregator: BucketAggregator,
    private readonly repository: BucketRepository,
    private readonly maxPendingBuckets = 5_000,
  ) {}
  flush(): Promise<number> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushNow().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }
  async flushAndDrain(): Promise<number> {
    let written = 0;
    for (;;) {
      if (this.flushing) written += await this.flushing;
      written += await this.flush();
      if (!this.pending.length && this.aggregator.isEmpty()) return written;
    }
  }
  private async flushNow(): Promise<number> {
    const buckets = [...this.pending, ...this.aggregator.snapshotAndReset()];
    this.pending = [];
    let written = 0;
    try {
      for (const bucket of buckets) {
        await this.repository.create({ values: { ...bucket, bucketStart: new Date(bucket.bucketStart) } });
        written += 1;
      }
      return written;
    } catch (error) {
      // Only re-queue what was not persisted, otherwise a mid-batch failure
      // would write the already-persisted rows again on the next attempt.
      this.pending = buckets.slice(written).slice(-this.maxPendingBuckets);
      throw error;
    }
  }
}
