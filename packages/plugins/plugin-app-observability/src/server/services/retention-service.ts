interface DestroyRepository {
  destroy(options: { filter: Record<string, unknown>; limit?: number }): Promise<number>;
}
export class RetentionService {
  constructor(
    private readonly buckets: DestroyRepository,
    private readonly alerts: DestroyRepository,
    private readonly now: () => number = Date.now,
  ) {}
  async cleanup(retentionDays: number, batchSize = 500): Promise<{ buckets: number; alerts: number }> {
    const cutoff = new Date(this.now() - retentionDays * 86_400_000);
    let bucketCount = 0;
    let alertCount = 0;
    for (;;) {
      const removed = await this.buckets.destroy({ filter: { bucketStart: { $lt: cutoff } }, limit: batchSize });
      bucketCount += removed;
      if (removed < batchSize) break;
    }
    for (;;) {
      const removed = await this.alerts.destroy({
        filter: { status: 'resolved', resolvedAt: { $lt: cutoff } },
        limit: batchSize,
      });
      alertCount += removed;
      if (removed < batchSize) break;
    }
    return { buckets: bucketCount, alerts: alertCount };
  }
}
