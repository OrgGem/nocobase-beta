// SPDX-License-Identifier: Apache-2.0

import { Op, type Database, type Model, type Repository, type Transaction } from '@nocobase/database';

type FlowModelAttachOptions = {
  parentId: string;
  subKey: 'page' | 'grid';
  subType: 'object';
};

type FlowModelRepository = Repository & {
  insertModel: (model: Record<string, unknown>, options: { transaction: Transaction }) => Promise<unknown>;
  attach: (
    uid: string,
    options: FlowModelAttachOptions,
    transactionOptions: { transaction: Transaction },
  ) => Promise<unknown>;
};

type CandidateMatch = {
  uid: string;
  matchesRouteId: boolean;
  matchesSchemaUid: boolean;
  configuredScore: number;
};

type ValidatedCandidate = CandidateMatch & {
  alreadyAttachedToParent: boolean;
  descendantCount: number;
  hasSelfPath: boolean;
  options: Record<string, unknown>;
  orphanRouteModelUids: string[];
  page: Model;
};

type RepairLogger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

export class RouteContentRepairError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RouteContentRepairError';
  }
}

function modelOptions(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return modelOptions(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function getRecordValue(record: unknown, key: string): unknown {
  if (!record || typeof record !== 'object') {
    return undefined;
  }

  const candidate = record as { get?: (field: string) => unknown } & Record<string, unknown>;
  return typeof candidate.get === 'function' ? candidate.get(key) : candidate[key];
}

function isRouteModelOptions(options: Record<string, unknown>): boolean {
  const schema = modelOptions(options.schema);
  return options.use === 'RouteModel' || schema.use === 'RouteModel';
}

function countConfiguredKeys(options: Record<string, unknown>): number {
  const props = modelOptions(options.props);
  const stepParams = modelOptions(options.stepParams);
  const flowRegistry = modelOptions(options.flowRegistry);
  return Object.keys(props).length + Object.keys(stepParams).length + Object.keys(flowRegistry).length;
}

async function isUidReferencedByLiveRoute(db: Database, schemaUid: string, transaction: Transaction): Promise<boolean> {
  const desktopRoute = await db.getRepository('desktopRoutes').findOne({ filter: { schemaUid }, transaction });
  if (desktopRoute) {
    return true;
  }
  if (typeof db.hasCollection === 'function' && db.hasCollection('nextAppRoutes')) {
    const hubRoute = await db.getRepository('nextAppRoutes').findOne({ filter: { schemaUid }, transaction });
    if (hubRoute) {
      return true;
    }
  }
  return false;
}

async function isOrphanRouteModelParent(
  db: Database,
  models: FlowModelRepository,
  paths: Repository,
  previousUid: string,
  childUid: string,
  transaction: Transaction,
): Promise<boolean> {
  if (await isUidReferencedByLiveRoute(db, previousUid, transaction)) {
    return false;
  }

  const previousModel = await models.model.findByPk(previousUid, { transaction, lock: true });
  if (!previousModel) {
    return true;
  }

  const previousOpts = modelOptions(previousModel.get('options'));
  if (!isRouteModelOptions(previousOpts)) {
    return false;
  }

  const previousAncestorPaths = await paths.find({ filter: { descendant: previousUid }, transaction });
  if (previousAncestorPaths.some((path) => Number(path.get('depth')) > 0)) {
    return false;
  }

  const previousChildren = await paths.find({ filter: { ancestor: previousUid, depth: 1 }, transaction });
  return !previousChildren.some((path) => String(path.get('descendant') || '') !== childUid);
}

async function ensureRouteModelAnchor(
  models: FlowModelRepository,
  paths: Repository,
  anchorUid: string,
  allowedChildUid: string | undefined,
  transaction: Transaction,
): Promise<boolean> {
  const existingAnchor = await models.model.findByPk(anchorUid, { transaction, lock: true });
  const parentPaths = await paths.find({ filter: { descendant: anchorUid }, transaction });
  if (parentPaths.some((path) => Number(path.get('depth')) > 0)) {
    throw new RouteContentRepairError(`The route model ${anchorUid} has an existing parent path.`);
  }

  const parentSelf = parentPaths.find((path) => path.get('ancestor') === anchorUid && Number(path.get('depth')) === 0);
  if (parentSelf && parentSelf.get('type')) {
    throw new RouteContentRepairError(`The route model ${anchorUid} has an incompatible self path.`);
  }

  if (existingAnchor) {
    if (!isRouteModelOptions(modelOptions(existingAnchor.get('options')))) {
      throw new RouteContentRepairError(`The route model ${anchorUid} is already used by another model.`);
    }
    if (!parentSelf) {
      await paths.create({
        values: { ancestor: anchorUid, descendant: anchorUid, depth: 0, type: null, async: false },
        transaction,
      });
      return true;
    }
    return false;
  }

  const parentChildren = await paths.find({ filter: { ancestor: anchorUid, depth: 1 }, transaction });
  if (parentChildren.some((path) => path.get('descendant') !== allowedChildUid)) {
    throw new RouteContentRepairError(`The route model ${anchorUid} already has other children.`);
  }

  if (parentSelf) {
    // A missing model can leave its self-path behind. Preserve that path and its descendants.
    await models.model.create(
      { uid: anchorUid, name: anchorUid, options: { use: 'RouteModel' } },
      { transaction, hooks: false },
    );
  } else {
    await models.insertModel({ uid: anchorUid, use: 'RouteModel' }, { transaction });
  }
  return true;
}

async function cleanupOrphanRouteModels(
  models: FlowModelRepository,
  paths: Repository,
  orphanUids: string[],
  transaction: Transaction,
) {
  for (const orphanUid of orphanUids) {
    const remainingDescendants = await paths.find({
      filter: { ancestor: orphanUid, depth: { [Op.gt]: 0 } },
      transaction,
    });
    if (remainingDescendants.length > 0) {
      continue;
    }
    await paths.destroy({ filter: { ancestor: orphanUid, descendant: orphanUid }, transaction });
    await models.model.destroy({ where: { uid: orphanUid }, transaction, hooks: false });
  }
}

async function scanDetachedCandidates(
  models: FlowModelRepository,
  expectedUse: 'RootPageModel' | 'BlockGridModel',
  anchorUid: string,
  directChildUids: Set<string>,
  transaction: Transaction,
  routeId?: string | number,
): Promise<CandidateMatch[]> {
  // Legacy JSON can store route ids as strings or numbers, or wrap the whole options object in a string.
  // Read bounded chunks so repair never loads the entire flowModels table into memory at once.
  const candidates: CandidateMatch[] = [];
  let afterUid: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const rows = await models.model.findAll({
      attributes: ['uid', 'options'],
      where: afterUid ? { uid: { [Op.gt]: afterUid } } : undefined,
      order: [['uid', 'ASC']],
      limit: 500,
      transaction,
    });

    for (const model of rows) {
      const uid = String(model.get('uid') || '');
      if (!uid || uid === anchorUid) {
        continue;
      }
      const options = modelOptions(model.get('options'));
      if (options.use !== expectedUse) {
        continue;
      }

      const props = modelOptions(options.props);
      const hasRouteId = props.routeId != null && String(props.routeId) !== '';
      const matchesRouteId =
        expectedUse === 'RootPageModel' &&
        routeId !== undefined &&
        hasRouteId &&
        String(props.routeId) === String(routeId);
      const matchesSchemaUid =
        (!hasRouteId || expectedUse === 'BlockGridModel') &&
        (options.parentId === anchorUid || options.parent === anchorUid);

      if (matchesRouteId || matchesSchemaUid || directChildUids.has(uid)) {
        candidates.push({
          uid,
          matchesRouteId,
          matchesSchemaUid,
          configuredScore: countConfiguredKeys(options),
        });
      }
    }

    hasMore = rows.length === 500;
    if (hasMore) {
      afterUid = String(rows[rows.length - 1].get('uid'));
    }
  }

  return candidates;
}

async function selectBestCandidate(
  db: Database,
  models: FlowModelRepository,
  paths: Repository,
  candidates: CandidateMatch[],
  expectedUse: 'RootPageModel' | 'BlockGridModel',
  anchorUid: string,
  directChildUids: Set<string>,
  transaction: Transaction,
  routeId?: string | number,
): Promise<{ candidate?: ValidatedCandidate; rejectionReason?: string }> {
  const validCandidates: ValidatedCandidate[] = [];
  let firstRejectionReason: string | undefined;

  for (const candidate of candidates) {
    const page = await models.model.findByPk(candidate.uid, { transaction, lock: true });
    if (!page) {
      firstRejectionReason ??= `The ${expectedUse} ${candidate.uid} no longer exists.`;
      continue;
    }

    const options = modelOptions(page.get('options'));
    const props = modelOptions(options.props);
    const hasRouteId = props.routeId != null && String(props.routeId) !== '';
    const stillMatchesRouteId =
      expectedUse === 'RootPageModel' &&
      routeId !== undefined &&
      hasRouteId &&
      String(props.routeId) === String(routeId);
    const stillMatchesSchemaUid =
      (!hasRouteId || expectedUse === 'BlockGridModel') &&
      (options.parentId === anchorUid || options.parent === anchorUid);

    if (
      options.use !== expectedUse ||
      (!stillMatchesRouteId && !stillMatchesSchemaUid && !directChildUids.has(candidate.uid))
    ) {
      firstRejectionReason ??= `The ${expectedUse} ${candidate.uid} changed while it was being repaired.`;
      continue;
    }

    const pagePaths = await paths.find({ filter: { descendant: candidate.uid }, transaction });
    const immediateParents = pagePaths.filter((path) => Number(path.get('depth')) === 1);
    if (
      immediateParents.length > 1 ||
      (pagePaths.some((path) => Number(path.get('depth')) > 1) && !immediateParents.length)
    ) {
      firstRejectionReason ??= `The ${expectedUse} ${candidate.uid} has an inconsistent parent path.`;
      continue;
    }

    const recordedParents = new Set(
      [options.parentId, options.parent, ...immediateParents.map((path) => path.get('ancestor'))].filter(
        (value): value is string => typeof value === 'string' && !!value && value !== anchorUid,
      ),
    );

    const orphanRouteModelUids: string[] = [];
    let ownedByAnotherParent = false;
    for (const previousUid of recordedParents) {
      const canReclaim = await isOrphanRouteModelParent(db, models, paths, previousUid, candidate.uid, transaction);
      if (!canReclaim) {
        ownedByAnotherParent = true;
        firstRejectionReason ??= `The ${expectedUse} ${candidate.uid} still belongs to another parent.`;
        break;
      }
      const previousExists = await models.model.findByPk(previousUid, { transaction });
      if (previousExists) {
        orphanRouteModelUids.push(previousUid);
      }
    }

    if (ownedByAnotherParent) {
      continue;
    }

    const descendants = await paths.find({
      filter: { ancestor: candidate.uid, depth: { [Op.gt]: 0 } },
      transaction,
    });
    const hasSelfPath = pagePaths.some(
      (path) => path.get('ancestor') === candidate.uid && Number(path.get('depth')) === 0,
    );
    const alreadyAttachedToParent = immediateParents.some((path) => path.get('ancestor') === anchorUid);

    validCandidates.push({
      ...candidate,
      matchesRouteId: stillMatchesRouteId,
      matchesSchemaUid: stillMatchesSchemaUid,
      configuredScore: countConfiguredKeys(options),
      alreadyAttachedToParent,
      descendantCount: descendants.length,
      hasSelfPath,
      options,
      orphanRouteModelUids,
      page,
    });
  }

  validCandidates.sort((left, right) => {
    if (left.alreadyAttachedToParent !== right.alreadyAttachedToParent) {
      return left.alreadyAttachedToParent ? -1 : 1;
    }
    if (left.descendantCount !== right.descendantCount) {
      return right.descendantCount - left.descendantCount;
    }
    if (left.matchesRouteId !== right.matchesRouteId) {
      return left.matchesRouteId ? -1 : 1;
    }
    if (left.matchesSchemaUid !== right.matchesSchemaUid) {
      return left.matchesSchemaUid ? -1 : 1;
    }
    if (left.configuredScore !== right.configuredScore) {
      return right.configuredScore - left.configuredScore;
    }
    return left.uid.localeCompare(right.uid);
  });

  return {
    candidate: validCandidates[0],
    rejectionReason: validCandidates.length === 0 ? firstRejectionReason : undefined,
  };
}

async function attachSelectedCandidate(
  models: FlowModelRepository,
  paths: Repository,
  selected: ValidatedCandidate,
  anchorUid: string,
  subKey: 'page' | 'grid',
  transaction: Transaction,
  routeId?: string | number,
) {
  if (!selected.hasSelfPath) {
    // attach() expects an existing self-path and does not recreate it for an existing model.
    await paths.create({
      values: { ancestor: selected.uid, descendant: selected.uid, depth: 0, type: subKey, async: true },
      transaction,
    });
  }

  const rawStoredOptions = selected.page.get('options');
  const nextOptions: Record<string, unknown> = { ...selected.options, async: true };
  if (subKey === 'page' && routeId !== undefined) {
    const props = modelOptions(nextOptions.props);
    if (props.routeId == null || String(props.routeId) === '') {
      nextOptions.props = { ...props, routeId };
    }
  }
  if (
    typeof rawStoredOptions === 'string' ||
    selected.options.async !== true ||
    nextOptions.props !== selected.options.props
  ) {
    // attach() expects an object and would otherwise spread a serialized string into character keys.
    await selected.page.update({ options: nextOptions }, { transaction, hooks: false });
  }

  await models.attach(selected.uid, { parentId: anchorUid, subKey, subType: 'object' }, { transaction });
  if (selected.hasSelfPath) {
    await paths.update({
      filter: { ancestor: selected.uid, descendant: selected.uid, depth: 0 },
      values: { type: subKey, async: true },
      transaction,
    });
  }
  await cleanupOrphanRouteModels(models, paths, selected.orphanRouteModelUids, transaction);
}

async function repairRouteSlotAnchor(
  db: Database,
  models: FlowModelRepository,
  paths: Repository,
  anchorUid: string,
  subKey: 'page' | 'grid',
  expectedUse: 'RootPageModel' | 'BlockGridModel',
  transaction: Transaction,
  routeId?: string | number,
): Promise<boolean> {
  const existingParent = await models.model.findByPk(anchorUid, { transaction, lock: true });
  if (existingParent) {
    return ensureRouteModelAnchor(models, paths, anchorUid, undefined, transaction);
  }

  const directChildren = await paths.find({ filter: { ancestor: anchorUid, depth: 1 }, transaction });
  const directChildUids = new Set(
    directChildren.map((path) => String(path.get('descendant') || '')).filter((uid) => Boolean(uid)),
  );
  const candidates = await scanDetachedCandidates(
    models,
    expectedUse,
    anchorUid,
    directChildUids,
    transaction,
    routeId,
  );

  if (candidates.length === 0) {
    await ensureRouteModelAnchor(models, paths, anchorUid, undefined, transaction);
    return true;
  }

  const { candidate: selected, rejectionReason } = await selectBestCandidate(
    db,
    models,
    paths,
    candidates,
    expectedUse,
    anchorUid,
    directChildUids,
    transaction,
    routeId,
  );
  if (!selected) {
    throw new RouteContentRepairError(
      rejectionReason || `No recoverable ${expectedUse} was found for route model ${anchorUid}.`,
    );
  }

  await ensureRouteModelAnchor(models, paths, anchorUid, selected.uid, transaction);
  await attachSelectedCandidate(models, paths, selected, anchorUid, subKey, transaction, routeId);
  return true;
}

async function repairChildTabRoutes(
  db: Database,
  models: FlowModelRepository,
  paths: Repository,
  routeId: string | number,
  transaction: Transaction,
): Promise<boolean> {
  const routes = db.getRepository('desktopRoutes');
  const tabRoutes = await routes.find({
    filter: { parentId: routeId, type: 'tabs' },
    transaction,
  });

  let repairedAnyTab = false;
  for (const tabRoute of tabRoutes) {
    const tabSchemaUid = getRecordValue(tabRoute, 'schemaUid');
    if (typeof tabSchemaUid !== 'string' || !tabSchemaUid) {
      continue;
    }
    const repaired = await repairRouteSlotAnchor(
      db,
      models,
      paths,
      tabSchemaUid,
      'grid',
      'BlockGridModel',
      transaction,
    );
    if (repaired) {
      repairedAnyTab = true;
    }
  }

  return repairedAnyTab;
}

/** Ensure a legacy V2 route and its tabs have valid RouteModel anchors, reconnecting detached content when present. */
export async function repairRouteContent(
  db: Database,
  routeId: string | number,
  schemaUid: string,
  transaction: Transaction,
) {
  const routes = db.getRepository('desktopRoutes');
  const route = await routes.model.findByPk(routeId, { transaction, lock: true });
  if (!route || route.get('type') !== 'flowPage' || route.get('schemaUid') !== schemaUid) {
    throw new RouteContentRepairError('The route changed while its page was being repaired.');
  }

  const models = db.getRepository('flowModels') as FlowModelRepository;
  const paths = db.getRepository('flowModelTreePath');

  const repairedPage = await repairRouteSlotAnchor(
    db,
    models,
    paths,
    schemaUid,
    'page',
    'RootPageModel',
    transaction,
    routeId,
  );
  const repairedTabs = await repairChildTabRoutes(db, models, paths, routeId, transaction);
  return repairedPage || repairedTabs;
}

function isEligibleDesktopFlowPage(route: unknown, hasUiLayouts: boolean): boolean {
  if (getRecordValue(route, 'type') !== 'flowPage') {
    return false;
  }
  const schemaUid = getRecordValue(route, 'schemaUid');
  if (typeof schemaUid !== 'string' || !schemaUid) {
    return false;
  }
  if (!hasUiLayouts) {
    return true;
  }
  const layouts = getRecordValue(route, 'uiLayouts');
  return Array.isArray(layouts) && layouts.some((layout) => getRecordValue(layout, 'layoutType') === 'desktop');
}

/** Scan desktop V2 routes on startup/upgrade and repair any missing RouteModel anchors for pages and tabs. */
export async function repairAllLegacyRouteContents(db: Database, logger?: RepairLogger): Promise<number> {
  if (
    !db ||
    typeof db.hasCollection !== 'function' ||
    !db.hasCollection('desktopRoutes') ||
    !db.hasCollection('flowModels') ||
    !db.hasCollection('flowModelTreePath')
  ) {
    return 0;
  }

  const hasUiLayouts = db.hasCollection('uiLayouts');
  const routesRepo = db.getRepository('desktopRoutes');
  const flowModelsRepo = db.getRepository('flowModels');
  const pathsRepo = db.getRepository('flowModelTreePath');

  const flowPageRoutes = await routesRepo.find({
    filter: { type: 'flowPage' },
    ...(hasUiLayouts ? { appends: ['uiLayouts'] } : {}),
  });
  const eligibleRoutes = flowPageRoutes.filter((route) => isEligibleDesktopFlowPage(route, hasUiLayouts));
  if (!eligibleRoutes.length) {
    return 0;
  }

  const routeIds = eligibleRoutes
    .map((route) => getRecordValue(route, 'id'))
    .filter((id): id is string | number => id !== undefined && id !== null && String(id) !== '');
  const tabRoutes = routeIds.length
    ? await routesRepo.find({
        filter: { parentId: routeIds, type: 'tabs' },
      })
    : [];

  const requiredUids = new Set<string>();
  const tabsByParentId = new Map<string, string[]>();
  for (const route of eligibleRoutes) {
    const schemaUid = String(getRecordValue(route, 'schemaUid'));
    requiredUids.add(schemaUid);
  }
  for (const tab of tabRoutes) {
    const parentId = getRecordValue(tab, 'parentId');
    const tabUid = getRecordValue(tab, 'schemaUid');
    if (parentId != null && typeof tabUid === 'string' && tabUid) {
      requiredUids.add(tabUid);
      const key = String(parentId);
      const list = tabsByParentId.get(key) || [];
      list.push(tabUid);
      tabsByParentId.set(key, list);
    }
  }

  const existingModelUids = new Set<string>();
  const existingSelfPathUids = new Set<string>();
  const allUids = Array.from(requiredUids);
  for (let index = 0; index < allUids.length; index += 500) {
    const chunk = allUids.slice(index, index + 500);
    const [foundModels, foundSelfPaths] = await Promise.all([
      flowModelsRepo.model.findAll({
        attributes: ['uid'],
        where: { uid: { [Op.in]: chunk } },
      }),
      pathsRepo.find({
        filter: { ancestor: chunk, depth: 0 },
      }),
    ]);
    for (const model of foundModels) {
      const uid = model.get('uid');
      if (typeof uid === 'string' && uid) {
        existingModelUids.add(uid);
      }
    }
    for (const selfPath of foundSelfPaths) {
      const ancestor = selfPath.get('ancestor');
      const descendant = selfPath.get('descendant');
      if (typeof ancestor === 'string' && ancestor && ancestor === descendant) {
        existingSelfPathUids.add(ancestor);
      }
    }
  }

  const isHealthyAnchor = (uid: string) => existingModelUids.has(uid) && existingSelfPathUids.has(uid);

  let repairedCount = 0;
  for (const route of eligibleRoutes) {
    const routeId = getRecordValue(route, 'id') as string | number;
    const schemaUid = String(getRecordValue(route, 'schemaUid'));
    const tabUids = tabsByParentId.get(String(routeId)) || [];
    const needsRepair = !isHealthyAnchor(schemaUid) || tabUids.some((tabUid) => !isHealthyAnchor(tabUid));
    if (!needsRepair) {
      continue;
    }

    try {
      const changed = await db.sequelize.transaction((transaction) =>
        repairRouteContent(db, routeId, schemaUid, transaction),
      );
      if (changed) {
        repairedCount += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn?.(
        `[plugin-router-configuration] Failed to auto-repair route ${String(routeId)} (${schemaUid}): ${message}`,
      );
    }
  }

  if (repairedCount > 0) {
    logger?.info?.(`[plugin-router-configuration] Repaired ${repairedCount} legacy V2 route(s).`);
  }
  return repairedCount;
}
