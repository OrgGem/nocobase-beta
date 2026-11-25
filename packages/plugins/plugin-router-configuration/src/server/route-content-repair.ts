// SPDX-License-Identifier: Apache-2.0

import { Op, type Database, type Repository, type Transaction } from '@nocobase/database';

type FlowModelRepository = Repository & {
  insertModel: (model: Record<string, unknown>, options: { transaction: Transaction }) => Promise<unknown>;
  attach: (
    uid: string,
    options: { parentId: string; subKey: 'page'; subType: 'object' },
    transactionOptions: { transaction: Transaction },
  ) => Promise<unknown>;
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

/** Reconnect a legacy page only when its route and former parent can be identified safely. */
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
  const parent = await models.model.findByPk(schemaUid, { transaction, lock: true });
  if (parent) {
    return false;
  }

  // Legacy JSON can store route ids as strings or numbers, or wrap the whole options object in a string.
  // Read bounded pages so repair does not load the entire flowModels table at once.
  const candidates: string[] = [];
  let afterUid: string | undefined;
  let hasMore = true;
  while (hasMore && candidates.length < 2) {
    const rows = await models.model.findAll({
      attributes: ['uid', 'options'],
      where: afterUid ? { uid: { [Op.gt]: afterUid } } : undefined,
      order: [['uid', 'ASC']],
      limit: 500,
      transaction,
    });
    for (const model of rows) {
      const options = modelOptions(model.get('options'));
      const props = modelOptions(options.props);
      if (options.use === 'RootPageModel' && props.routeId != null && String(props.routeId) === String(routeId)) {
        candidates.push(String(model.get('uid')));
      }
    }
    hasMore = rows.length === 500;
    if (hasMore) {
      afterUid = String(rows[rows.length - 1].get('uid'));
    }
  }
  if (candidates.length !== 1) {
    throw new RouteContentRepairError(`Expected one page for route ${routeId}, found ${candidates.length}.`);
  }

  const pageUid = candidates[0];
  if (typeof pageUid !== 'string' || !pageUid || pageUid === schemaUid) {
    throw new RouteContentRepairError(`The page for route ${routeId} has an invalid uid.`);
  }

  const page = await models.model.findByPk(pageUid, { transaction, lock: true });
  if (!page) {
    throw new RouteContentRepairError(`The page for route ${routeId} no longer exists.`);
  }
  const options = modelOptions(page.get('options'));
  const props = modelOptions(options.props);
  if (options.use !== 'RootPageModel' || String(props.routeId) !== String(routeId)) {
    throw new RouteContentRepairError(`The page for route ${routeId} changed while it was being repaired.`);
  }

  const paths = db.getRepository('flowModelTreePath');
  const pagePaths = await paths.find({ filter: { descendant: pageUid }, transaction });
  const immediateParents = pagePaths.filter((path) => Number(path.get('depth')) === 1);
  if (
    immediateParents.length > 1 ||
    (pagePaths.some((path) => Number(path.get('depth')) > 1) && !immediateParents.length)
  ) {
    throw new RouteContentRepairError(`The page ${pageUid} has an inconsistent parent path.`);
  }

  const recordedParents = new Set(
    [options.parentId, options.parent, ...immediateParents.map((path) => path.get('ancestor'))].filter(
      (value): value is string => typeof value === 'string' && !!value && value !== schemaUid,
    ),
  );
  for (const previousUid of recordedParents) {
    const previousModel = await models.model.findByPk(previousUid, { transaction, lock: true });
    const previousRoute = await routes.findOne({ filter: { schemaUid: previousUid }, transaction });
    if (previousModel || previousRoute) {
      throw new RouteContentRepairError(`The page ${pageUid} still belongs to another parent.`);
    }
  }

  const parentPaths = await paths.find({ filter: { descendant: schemaUid }, transaction });
  if (parentPaths.some((path) => Number(path.get('depth')) > 0)) {
    throw new RouteContentRepairError(`The route model ${schemaUid} has an existing parent path.`);
  }

  const parentSelf = parentPaths.find((path) => path.get('ancestor') === schemaUid && Number(path.get('depth')) === 0);
  if (parentSelf && parentSelf.get('type')) {
    throw new RouteContentRepairError(`The route model ${schemaUid} has an incompatible self path.`);
  }
  const parentChildren = await paths.find({ filter: { ancestor: schemaUid, depth: 1 }, transaction });
  if (parentChildren.some((path) => path.get('descendant') !== pageUid)) {
    throw new RouteContentRepairError(`The route model ${schemaUid} already has other children.`);
  }
  if (parentSelf) {
    // A missing model can leave its self-path behind. Preserve that path and its descendants.
    await models.model.create(
      { uid: schemaUid, name: schemaUid, options: { use: 'RouteModel' } },
      { transaction, hooks: false },
    );
  } else {
    await models.insertModel({ uid: schemaUid, use: 'RouteModel' }, { transaction });
  }

  const pageSelf = pagePaths.find((path) => path.get('ancestor') === pageUid && Number(path.get('depth')) === 0);
  if (!pageSelf) {
    // attach() expects an existing self-path and does not recreate it for an existing model.
    await paths.create({
      values: { ancestor: pageUid, descendant: pageUid, depth: 0, type: 'page', async: true },
      transaction,
    });
  }
  if (typeof page.get('options') === 'string') {
    // attach() expects an object and would otherwise spread the serialized string into character keys.
    await page.update({ options }, { transaction, hooks: false });
  }
  await models.attach(pageUid, { parentId: schemaUid, subKey: 'page', subType: 'object' }, { transaction });
  return true;
}
