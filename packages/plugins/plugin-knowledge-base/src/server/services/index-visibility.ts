// SPDX-License-Identifier: Apache-2.0

import type PluginKnowledgeBaseServer from '../plugin';

type Candidate = { metadata?: Record<string, unknown> };
type LiveIndexRow = {
  id: string | number;
  knowledgeBaseId?: string | number | null;
  indexDeleted?: boolean | null;
  activeIndexRevision?: string | null;
};
type LiveIndexRecord = LiveIndexRow & { toJSON?: () => LiveIndexRow };

/** Legacy chunks remain visible only while their live document has no active revision. */
export async function filterCurrentDocuments<T extends Candidate>(
  plugin: PluginKnowledgeBaseServer,
  items: T[],
): Promise<T[]> {
  const ids = Array.from(
    new Set(
      items
        .map((item) => item.metadata?.documentId)
        .filter((id) => id != null && String(id))
        .map(String),
    ),
  );
  if (!ids.length) return [];
  const records: LiveIndexRecord[] = await plugin.db.getRepository('aiKnowledgeBaseDocuments').find({
    filter: { id: { $in: ids } },
    fields: ['id', 'knowledgeBaseId', 'indexDeleted', 'activeIndexRevision'],
  });
  const byId = new Map<string, LiveIndexRow>(
    records.map((record): [string, LiveIndexRow] => {
      const row = record.toJSON ? record.toJSON() : record;
      return [String(row.id), row];
    }),
  );
  return items.filter((item) => {
    const metadata = item.metadata ?? {};
    const row = byId.get(String(metadata.documentId ?? ''));
    const kbId = metadata.knowledgeBaseOuterId ?? metadata.knowledgeBaseId;
    if (!row || row.indexDeleted || kbId == null || String(row.knowledgeBaseId) !== String(kbId)) return false;
    const revision = metadata.indexRevision;
    return row.activeIndexRevision == null
      ? revision == null
      : String(revision ?? '') === String(row.activeIndexRevision);
  });
}
