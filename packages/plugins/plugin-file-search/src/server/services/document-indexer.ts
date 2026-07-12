import type { Context } from '@nocobase/actions';
import { DocumentTextExtractor } from './document-text-extractor';
import { PageIndexRunnerService } from './pageindex-runner';
import { LlmServiceMapper } from './llm-service-mapper';
import { getDisplayFilename, resolveExtname } from './file-utils';
import { getOrCreateSettings } from './settings';

export class DocumentIndexer {
  private readonly extractor: DocumentTextExtractor;
  private readonly runner: PageIndexRunnerService;
  private readonly llmMapper: LlmServiceMapper;

  constructor(private readonly app: any) {
    this.extractor = new DocumentTextExtractor(app);
    this.runner = new PageIndexRunnerService(app);
    this.llmMapper = new LlmServiceMapper(app);
  }

  async indexDocument(ctx: Context, documentId: number | string) {
    const docRepo = ctx.db.getRepository('fileSearchDocuments');
    const document = await docRepo.findOne({ filterByTk: documentId });
    if (!document) {
      throw new Error(`fileSearchDocuments record ${documentId} not found.`);
    }

    const fileCollection = document.get('fileCollection') as string;
    const fileId = document.get('fileId') as string;
    const fileRepo = ctx.db.getRepository(fileCollection);
    if (!fileRepo) {
      throw new Error(`File collection "${fileCollection}" not found.`);
    }
    const file = await fileRepo.findOne({ filterByTk: fileId });
    if (!file) {
      await docRepo.update({ filterByTk: documentId, values: { status: 'deleted' } });
      throw new Error(`Source file ${fileCollection}:${fileId} not found.`);
    }

    const attachment = typeof file.toJSON === 'function' ? file.toJSON() : file;
    const settings = await getOrCreateSettings(ctx.db);
    const llm = await this.llmMapper.resolveEnv(settings);
    if (!llm.ok) {
      throw new Error(llm.message);
    }

    const extracted = await this.extractor.extract(ctx, attachment, settings);
    try {
      const indexed = await this.runner.indexFile(settings, extracted.filePath, extracted.mode, llm.env);
      await docRepo.update({
        filterByTk: documentId,
        values: {
          filename: getDisplayFilename(attachment),
          mimetype: attachment.mimetype,
          extname: resolveExtname(attachment),
          size: attachment.size,
          checksum: extracted.checksum,
          status: 'indexed',
          pageIndexDocId: indexed.doc_id,
          indexedAt: new Date(),
          errorMessage: null,
        },
      });
      return indexed;
    } finally {
      await extracted.cleanup();
    }
  }
}
