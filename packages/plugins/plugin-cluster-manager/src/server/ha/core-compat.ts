/**
 * Core compatibility shims.
 *
 * These hooks compensate for upstream defects that the cluster manager must not
 * fix in place (core and `@nocobase/*` plugins are read-only for this package).
 * Every shim here is additive, idempotent, and safe to run on a core release
 * where the defect has already been fixed.
 */

/**
 * NocoBase core's ACL merges the `own` strategy filter (`createdById`) into the
 * request filter and then validates it with `checkFilterParams`, which throws
 * `NoPermissionError` when the target collection has no `createdById` field.
 *
 * `plugin-file-manager` declares `createdBy: true` on `attachments` (so the
 * column exists) but the metadata field is not registered on the collection, so
 * non-root roles uploading attachments hit that guard and receive a 403.
 * Declaring the field explicitly unblocks them.
 *
 * Safe on fixed cores: `extendCollection` only ensures the field metadata
 * exists; the physical column is already created by the `createdBy: true`
 * option, so no migration is required.
 */
export function ensureAttachmentsCreatedByField(db: {
  extendCollection: (options: { name: string; fields: unknown[] }) => void;
}): boolean {
  db.extendCollection({
    name: 'attachments',
    fields: [
      {
        type: 'bigInt',
        name: 'createdById',
      },
    ],
  });
  return true;
}
