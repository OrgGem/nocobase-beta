import type { Context } from '@nocobase/actions';
import type { ResourceOptions } from '@nocobase/resourcer';
import { Op, col, fn } from 'sequelize';

interface UsageSummaryRow {
  requestCount?: string | number;
  inputTokens?: string | number;
  outputTokens?: string | number;
  totalTokens?: string | number;
}

interface CostSummaryRow {
  currency?: string;
  totalCost?: string | number;
}

function buildWhere(ctx: Context) {
  const params = ctx.action.params;
  const where: Record<string, unknown> = {};
  const start = typeof params.start === 'string' ? new Date(params.start) : undefined;
  const end = typeof params.end === 'string' ? new Date(params.end) : undefined;

  if ((start && !Number.isNaN(start.getTime())) || (end && !Number.isNaN(end.getTime()))) {
    const startedAt: Record<symbol, Date> = {};
    if (start && !Number.isNaN(start.getTime())) startedAt[Op.gte] = start;
    if (end && !Number.isNaN(end.getTime())) startedAt[Op.lte] = end;
    where.startedAt = startedAt;
  }
  if (params.userId !== undefined && params.userId !== '') where.userId = params.userId;
  if (params.resolvedService) where.resolvedService = params.resolvedService;
  if (params.resolvedModel) where.resolvedModel = params.resolvedModel;
  if (params.status) where.status = params.status;
  return where;
}

const aiApiUsageMonitorResource: ResourceOptions = {
  name: 'aiApiUsageMonitor',
  actions: {
    async summary(ctx, next) {
      const model = ctx.db.getCollection('aiApiUsageRecords').model;
      const where = buildWhere(ctx);
      const totals = (await model.findOne({
        attributes: [
          [fn('COUNT', col('id')), 'requestCount'],
          [fn('COALESCE', fn('SUM', col('inputTokens')), 0), 'inputTokens'],
          [fn('COALESCE', fn('SUM', col('outputTokens')), 0), 'outputTokens'],
          [fn('COALESCE', fn('SUM', col('totalTokens')), 0), 'totalTokens'],
        ],
        where,
        raw: true,
      })) as unknown as UsageSummaryRow;
      const costs = (await model.findAll({
        attributes: ['currency', [fn('COALESCE', fn('SUM', col('estimatedCost')), 0), 'totalCost']],
        where: { ...where, estimatedCost: { [Op.ne]: null } },
        group: ['currency'],
        raw: true,
      })) as unknown as CostSummaryRow[];

      ctx.body = {
        requestCount: Number(totals?.requestCount ?? 0),
        inputTokens: Number(totals?.inputTokens ?? 0),
        outputTokens: Number(totals?.outputTokens ?? 0),
        totalTokens: Number(totals?.totalTokens ?? 0),
        costsByCurrency: costs.map((item) => ({
          currency: item.currency || 'USD',
          totalCost: String(item.totalCost ?? 0),
        })),
      };
      await next();
    },
  },
};

export default aiApiUsageMonitorResource;
