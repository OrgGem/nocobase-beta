import type { ObservabilityBucket } from './bucket-aggregator';
import { BucketAggregator } from './bucket-aggregator';
interface BucketRepository {
  create(options: { values: Record<string, unknown> }): Promise<unknown>;
}
export class BucketFlushService {
  private flushing: Promise<number> | null = null;
  private pending: ObservabilityBucket[] | null = null;
  constructor(
    private readonly aggregator: BucketAggregator,
    private readonly repository: BucketRepository,
  ) {}
  flush(): Promise<number> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushNow().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }
  private async flushNow(): Promise<number> {
    const buckets = this.pending ?? this.aggregator.snapshotAndReset();
    this.pending = null;
    try {
      for (const bucket of buckets)
        await this.repository.create({ values: { ...bucket, bucketStart: new Date(bucket.bucketStart) } });
      return buckets.length;
    } catch (error) {
      this.pending = buckets;
      throw error;
    }
  }
}
