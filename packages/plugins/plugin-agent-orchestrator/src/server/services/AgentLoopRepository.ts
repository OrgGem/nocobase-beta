function toPlain(record: any) {
  return record?.toJSON?.() || record;
}

function trimText(value: any, max = 50000) {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (value != null) {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

export class AgentLoopRepository {
  constructor(private readonly plugin: any) {}

  get db() {
    return this.plugin.db;
  }

  async getRun(runId: string | number) {
    const run = await this.db.getRepository('agentLoopRuns').findOne({
      filter: { id: runId },
    });
    return run ? toPlain(run) : null;
  }

  async requireRun(runId: string | number) {
    const run = await this.getRun(runId);
    if (!run) {
      throw new Error(`Agent loop run "${runId}" was not found.`);
    }
    return run;
  }

  async createRun(values: any) {
    const run = await this.db.getRepository('agentLoopRuns').create({
      values,
    });
    return toPlain(run);
  }

  async updateRun(runId: string | number, values: any) {
    await this.db.getRepository('agentLoopRuns').update({
      filterByTk: runId,
      values,
    });
  }

  async getStep(stepId: string | number) {
    const step = await this.db.getRepository('agentLoopSteps').findOne({
      filter: { id: stepId },
    });
    return step ? toPlain(step) : null;
  }

  async requireStep(stepId: string | number) {
    const step = await this.getStep(stepId);
    if (!step) {
      throw new Error(`Agent loop step "${stepId}" was not found.`);
    }
    return step;
  }

  async createStep(values: any) {
    const step = await this.db.getRepository('agentLoopSteps').create({
      values,
    });
    return toPlain(step);
  }

  async updateStep(stepId: string | number, values: any) {
    await this.db.getRepository('agentLoopSteps').update({
      filterByTk: stepId,
      values,
    });
  }

  async getSteps(runId: string | number) {
    const steps = await this.db.getRepository('agentLoopSteps').find({
      filter: { runId },
      sort: ['index', 'createdAt'],
      pageSize: 1000,
    });
    return steps.map(toPlain);
  }

  async createEvent(values: any) {
    const record = await this.db.getRepository('agentLoopEvents').create({
      values: {
        ...values,
        content: trimText(values.content || '', 10000),
        payload: values.payload || {},
        createdAt: new Date(),
      },
    });
    return toPlain(record);
  }

  async getEvents(runId: string | number) {
    const events = await this.db.getRepository('agentLoopEvents').find({
      filter: { runId },
      sort: ['createdAt'],
      pageSize: 500,
    });
    return events.map(toPlain);
  }

  async getLinkedSpans(runId: string | number, rootRunId?: string) {
    const repo = this.db.getRepository('agentExecutionSpans');
    if (!repo) return [];
    const filters = [];
    if (rootRunId) filters.push({ rootRunId });
    filters.push({ 'metadata.agentLoopRunId': String(runId) });
    try {
      const rows = await repo.find({
        filter: { $or: filters },
        sort: ['createdAt'],
        pageSize: 1000,
      });
      return rows.map(toPlain);
    } catch {
      if (!rootRunId) return [];
      const rows = await repo.find({
        filter: { rootRunId },
        sort: ['createdAt'],
        pageSize: 1000,
      });
      return rows.map(toPlain);
    }
  }

  async getLinkedSkillExecutions(runId: string | number, steps: any[]) {
    const ids = Array.from(
      new Set(
        steps
          .map((step) => step.skillExecutionId)
          .filter(Boolean)
          .map(String),
      ),
    );
    const repo = this.db.getRepository('skillExecutions');
    if (!repo) return [];
    const filters: any[] = [{ agentLoopRunId: String(runId) }];
    if (ids.length) {
      filters.push({ id: { $in: ids } });
    }
    const rows = await repo.find({
      filter: { $or: filters },
      sort: ['createdAt'],
      pageSize: 1000,
    });
    return rows.map(toPlain);
  }

  async lockRun(runId: string | number, lockName: string, durationMs: number): Promise<boolean> {
    const repo = this.db.getRepository('agentLoopRuns');
    if (!repo) return false;
    const now = new Date();
    const Op = repo.model.sequelize.Sequelize.Op;

    const result = await repo.model.update(
      {
        lockedBy: lockName,
        lockedUntil: new Date(now.getTime() + durationMs),
      },
      {
        where: {
          id: runId,
          [Op.or]: [
            { lockedBy: null },
            { lockedUntil: { [Op.lt]: now.toISOString() } },
            { lockedBy: lockName }
          ]
        }
      }
    );

    const affectedCount = Array.isArray(result) ? result[0] : Number(result || 0);
    return affectedCount > 0;
  }

  async unlockRun(runId: string | number) {
    await this.updateRun(runId, {
      lockedBy: null,
      lockedUntil: null,
    });
  }
}
