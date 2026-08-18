import { DEFAULT_SETTINGS, SelectorSettingsService } from '../services/settings-service';
import { FeedbackService } from '../services/feedback-service';
import { FakeDatabase } from './helpers/fake-database';

const setup = (options?: { settings?: Partial<typeof DEFAULT_SETTINGS> }) => {
  const database = new FakeDatabase();
  const settingsValues = { ...DEFAULT_SETTINGS, ...(options?.settings ?? {}) };
  const settings = { get: async () => settingsValues } as unknown as SelectorSettingsService;
  const service = new FeedbackService({ database, settings });
  return { database, service };
};

const seedApp = async (database: FakeDatabase) => {
  return database.repo('selectorApps').create({
    values: { name: 'crm', status: 'active', dryRun: false },
  });
};

const seedEntry = async (database: FakeDatabase, values?: Record<string, unknown>) => {
  return database.repo('selectorEntries').create({
    values: {
      appId: 1,
      elementKey: 'k1',
      currentSelector: '#login',
      selectorType: 'css',
      fallbackSelectors: [],
      signature: null,
      status: 'active',
      pinned: false,
      confidence: 0.5,
      hitCount: 1,
      successCount: 0,
      failCount: 0,
      failStreak: 0,
      probationSuccessCount: 0,
      version: 1,
      resolvedBy: 'client',
      ...values,
    },
  });
};

const seedVersion = async (database: FakeDatabase, values?: Record<string, unknown>) => {
  return database.repo('selectorVersions').create({
    values: {
      entryId: 1,
      selector: '#login',
      selectorType: 'css',
      source: 'client',
      confidence: 0.5,
      status: 'active',
      successCount: 0,
      failCount: 0,
      ...values,
    },
  });
};

const entryRow = (database: FakeDatabase) => database.repo('selectorEntries').rows[0];

describe('FeedbackService', () => {
  describe('validation', () => {
    it('rejects a missing app', async () => {
      const { service } = setup();
      await expect(service.report({ app: '', elementKey: 'k', outcome: 'success' })).rejects.toThrow(/app/);
    });

    it('rejects a missing elementKey', async () => {
      const { service } = setup();
      await expect(service.report({ app: 'crm', elementKey: '', outcome: 'success' })).rejects.toThrow(/elementKey/);
    });

    it('rejects an invalid outcome', async () => {
      const { database, service } = setup();
      await seedApp(database);
      await expect(service.report({ app: 'crm', elementKey: 'k', outcome: 'maybe' as never })).rejects.toThrow(
        /Invalid outcome/,
      );
      expect(database.repo('selectorFeedbacks').rows).toHaveLength(0);
    });

    it('rejects unknown apps', async () => {
      const { service } = setup();
      await expect(service.report({ app: 'missing', elementKey: 'k', outcome: 'success' })).rejects.toThrow(
        /not registered/,
      );
    });
  });

  describe('recording', () => {
    it('records feedback for unknown elements without entry side effects', async () => {
      const { database, service } = setup();
      await seedApp(database);
      const result = await service.report({ app: 'crm', elementKey: 'unknown', outcome: 'fail' });
      expect(result).toEqual({ recorded: true });
      expect(database.repo('selectorFeedbacks').rows).toHaveLength(1);
      expect(database.repo('selectorEntries').rows).toHaveLength(0);
    });

    it('stores the full feedback context', async () => {
      const { database, service } = setup();
      await seedApp(database);
      await seedEntry(database);
      await service.report({
        app: 'crm',
        elementKey: 'k1',
        outcome: 'fail',
        selectorUsed: '#login',
        failureType: 'not_found',
        signatureMatch: false,
        pageUrl: 'https://crm.example/login',
        errorMessage: 'element not found',
        agentId: 'uipath-bot-1',
        runId: 'run-7',
      });
      expect(database.repo('selectorFeedbacks').rows[0]).toMatchObject({
        entryId: 1,
        outcome: 'fail',
        failureType: 'not_found',
        signatureMatch: false,
        agentId: 'uipath-bot-1',
        runId: 'run-7',
      });
    });
  });

  describe('dirty evidence', () => {
    it('does not touch confidence or lifecycle on page_error failures', async () => {
      const { database, service } = setup();
      await seedApp(database);
      await seedEntry(database, { confidence: 0.5, failStreak: 1 });
      const result = await service.report({
        app: 'crm',
        elementKey: 'k1',
        outcome: 'fail',
        failureType: 'page_error',
      });
      expect(result).toMatchObject({ recorded: true, entryStatus: 'active', confidence: 0.5 });
      expect(entryRow(database)).toMatchObject({ failCount: 0, failStreak: 1, confidence: 0.5, status: 'active' });
    });
  });

  describe('success feedback', () => {
    it('raises confidence with EWMA and resets the fail streak', async () => {
      const { database, service } = setup();
      await seedApp(database);
      await seedEntry(database, { confidence: 0.5, failStreak: 2 });
      const result = await service.report({ app: 'crm', elementKey: 'k1', outcome: 'success' });
      expect(result.confidence).toBe(0.625);
      expect(entryRow(database)).toMatchObject({ confidence: 0.625, failStreak: 0, successCount: 1 });
    });

    it('promotes probation to active after the success target', async () => {
      const { database, service } = setup();
      await seedApp(database);
      await seedEntry(database, { status: 'probation' });
      await service.report({ app: 'crm', elementKey: 'k1', outcome: 'success' });
      await service.report({ app: 'crm', elementKey: 'k1', outcome: 'verified' });
      expect(entryRow(database).status).toBe('probation');
      const result = await service.report({ app: 'crm', elementKey: 'k1', outcome: 'success' });
      expect(result.entryStatus).toBe('active');
      expect(entryRow(database)).toMatchObject({ status: 'active', probationSuccessCount: 3 });
    });

    it('recovers a degraded entry once confidence crosses the threshold', async () => {
      const { database, service } = setup();
      await seedApp(database);
      await seedEntry(database, { status: 'degraded', confidence: 0.55 });
      const result = await service.report({ app: 'crm', elementKey: 'k1', outcome: 'success' });
      expect(result.entryStatus).toBe('active');
      expect(entryRow(database).status).toBe('active');
    });

    it('keeps quarantined entries sticky', async () => {
      const { database, service } = setup();
      await seedApp(database);
      await seedEntry(database, { status: 'quarantined', confidence: 0.2 });
      const result = await service.report({ app: 'crm', elementKey: 'k1', outcome: 'success' });
      expect(result.entryStatus).toBe('quarantined');
      expect(entryRow(database).status).toBe('quarantined');
    });

    it('attributes the success to the version the client used', async () => {
      const { database, service } = setup();
      await seedApp(database);
      await seedEntry(database, { currentSelector: '#new' });
      await seedVersion(database, { selector: '#old', status: 'superseded' });
      await seedVersion(database, { selector: '#new', status: 'active' });
      await service.report({ app: 'crm', elementKey: 'k1', outcome: 'success', selectorUsed: '#new' });
      const versions = database.repo('selectorVersions').rows;
      expect(versions[0].successCount).toBe(0);
      expect(versions[1].successCount).toBe(1);
    });
  });

  describe('failure feedback', () => {
    it('lowers confidence and counts the fail streak', async () => {
      const { database, service } = setup();
      await seedApp(database);
      await seedEntry(database, { confidence: 0.5 });
      const result = await service.report({ app: 'crm', elementKey: 'k1', outcome: 'fail' });
      expect(result.confidence).toBe(0.375);
      expect(result.entryStatus).toBe('active');
      expect(entryRow(database)).toMatchObject({ confidence: 0.375, failStreak: 1, failCount: 1 });
    });

    it('degrades an entry after the fail streak limit', async () => {
      const { database, service } = setup();
      await seedApp(database);
      await seedEntry(database, { confidence: 0.9 });
      await service.report({ app: 'crm', elementKey: 'k1', outcome: 'fail' });
      await service.report({ app: 'crm', elementKey: 'k1', outcome: 'fail' });
      expect(entryRow(database).status).toBe('active');
      const result = await service.report({ app: 'crm', elementKey: 'k1', outcome: 'fail' });
      expect(result.entryStatus).toBe('degraded');
      expect(entryRow(database)).toMatchObject({ status: 'degraded', failStreak: 3 });
    });

    it('quarantines when confidence collapses together with the streak', async () => {
      const { database, service } = setup();
      await seedApp(database);
      await seedEntry(database, { confidence: 0.4, failStreak: 2 });
      const result = await service.report({ app: 'crm', elementKey: 'k1', outcome: 'fail' });
      expect(result.entryStatus).toBe('quarantined');
      expect(entryRow(database).status).toBe('quarantined');
      expect(entryRow(database).circuitBrokenUntil).toBeTruthy();
    });

    it('auto-rolls back to the newest proven version', async () => {
      const { database, service } = setup();
      await seedApp(database);
      await seedEntry(database, {
        status: 'probation',
        currentSelector: '#new',
        version: 2,
        confidence: 0.5,
      });
      await seedVersion(database, { selector: '#old', status: 'superseded', successCount: 5, confidence: 0.8 });
      await seedVersion(database, { selector: '#new', status: 'active', source: 'heuristic' });

      const first = await service.report({ app: 'crm', elementKey: 'k1', outcome: 'fail', selectorUsed: '#new' });
      expect(first.rolledBack).toBeUndefined();
      expect(entryRow(database).currentSelector).toBe('#new');

      const second = await service.report({ app: 'crm', elementKey: 'k1', outcome: 'fail', selectorUsed: '#new' });
      expect(second).toMatchObject({ rolledBack: true, newSelector: '#old', entryStatus: 'probation', version: 3 });

      expect(entryRow(database)).toMatchObject({
        currentSelector: '#old',
        status: 'probation',
        resolvedBy: 'rollback',
        failStreak: 0,
        confidence: 0.8,
        version: 3,
      });
      const versions = database.repo('selectorVersions').rows;
      expect(versions[0].status).toBe('active');
      expect(versions[1]).toMatchObject({ status: 'rolled_back', failCount: 2 });
      expect(versions[1].rolledBackAt).toBeTruthy();
    });

    it('never rolls back to a version that never succeeded', async () => {
      const { database, service } = setup({ settings: { rollbackFailLimit: 1 } });
      await seedApp(database);
      await seedEntry(database, { status: 'probation', currentSelector: '#new', version: 2 });
      await seedVersion(database, { selector: '#old', status: 'superseded', successCount: 0 });
      await seedVersion(database, { selector: '#new', status: 'active' });

      const result = await service.report({ app: 'crm', elementKey: 'k1', outcome: 'fail', selectorUsed: '#new' });
      expect(result.rolledBack).toBeUndefined();
      expect(entryRow(database).currentSelector).toBe('#new');
      expect(database.repo('selectorVersions').rows[0].status).toBe('superseded');
    });
  });
});
