import { Migration } from '@nocobase/server';

/**
 * Migration 3: enforce the partner-scoped access model.
 *
 * Every API route and every plugin API key must belong to a partner, and a
 * role may call routes only when bound to the same partner (see the new
 * apiPartnerRoles collection). Rules:
 *  - apiPartners: ensure at least one partner exists so routes/keys can be
 *    backfilled (creates a "__default__" partner when the table is empty).
 *  - apiRoutes.partnerId: backfill NULL rows to the default partner.
 *  - apiManagerApiKeys.partnerId: backfill NULL rows to the default partner.
 *
 * apiPartnerRoles is created automatically by the collection sync when the app
 * starts (no new table here); this migration only normalises existing data.
 *
 * Uses repository queries (not raw SQL) so it works on every supported
 * dialect (postgres, mysql, mariadb, sqlite).
 */
export default class extends Migration {
  on = 'afterLoad';

  async up() {
    const db = this.app.db;

    const getDefaultPartnerId = async (): Promise<number> => {
      const partnerRepo = db.getRepository('apiPartners');
      const any = await partnerRepo.findOne({});
      if (any) {
        return Number(any.get('id'));
      }
      const created = await partnerRepo.create({
        values: { name: '__default__', notes: 'Auto-created default partner for orphaned routes/keys', enabled: true },
      });
      return Number(created.get('id'));
    };

    const backfillPartner = async (collectionName: 'apiRoutes' | 'apiManagerApiKeys') => {
      const collection = db.getCollection(collectionName);
      if (!collection || !collection.getField('partnerId')) {
        return;
      }
      const repo = db.getRepository(collectionName);
      try {
        const orphans = await repo.find({
          filter: {
            $or: [{ partnerId: null }, { partnerId: { $lte: 0 } }],
          },
        });
        if (orphans.length === 0) {
          return;
        }
        const defaultId = await getDefaultPartnerId();
        await repo.update({
          filter: {
            $or: [{ partnerId: null }, { partnerId: { $lte: 0 } }],
          },
          values: { partnerId: defaultId },
        });
        db.logger?.info?.(`[api-manager] backfilled ${orphans.length} ${collectionName} rows to partner ${defaultId}`);
      } catch (error) {
        db.logger?.warn?.(`[api-manager] migration backfill ${collectionName} skipped: ${(error as Error).message ?? error}`);
      }
    };

    await backfillPartner('apiRoutes');
    await backfillPartner('apiManagerApiKeys');
  }
}
