import { Context, Next } from '@nocobase/actions';
import { Repository } from '@nocobase/database';
import sanitizeHtml from 'sanitize-html';
// @ts-ignore
import { PluginAIServer } from '@nocobase/plugin-ai';
// @ts-ignore
import { PluginFileManagerServer } from '@nocobase/plugin-file-manager';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

async function fetchFileContent(app: any, file: any): Promise<string> {
  const fileManager = app.pm.get('file-manager') as PluginFileManagerServer;
  if (!fileManager) return '';
  const url = await fileManager.getFileURL(file);

  try {
    if (url.startsWith('http')) {
      const response = await axios.get(url, { responseType: 'text', timeout: 15000 });
      return response.data;
    } else {
      let localPath = url;
      if (process.env.APP_PUBLIC_PATH && localPath.startsWith(process.env.APP_PUBLIC_PATH)) {
        localPath = localPath.slice(process.env.APP_PUBLIC_PATH.length);
      }
      localPath = path.join(process.cwd(), localPath);
      const data = await fs.promises.readFile(localPath, 'utf8');
      return data;
    }
  } catch (err) {
    app.log.error(`Failed to read file content for document ${file.id}`, err);
    return `[Failed to read document: ${file.filename}]`;
  }
}

export async function build(ctx: Context, next: Next) {
  const { filterByTk } = ctx.action.params;
  const repository = ctx.db.getRepository('aiBuildGuideSpaces') as Repository;

  const space = await repository.findById(filterByTk);

  if (!space) {
    ctx.throw(404, 'Space not found');
  }

  // Concurrency guard — reject if already building
  if (space.get('status') === 'building') {
    ctx.throw(409, 'A build is already in progress for this space');
  }

  // Capture the long-lived Application reference — NOT the per-request ctx
  const app = ctx.app;
  const db = ctx.db;

  try {
    // 1. Set status to building
    await repository.update({
      filterByTk,
      values: {
        status: 'building',
        buildLog: null,
      },
    });

    // 2. Run the LLM pipeline asynchronously (fire-and-forget)
    const bgPromise = (async () => {
      const bgRepo = db.getRepository('aiBuildGuideSpaces') as Repository;

      // 2a. Extract Document contexts
      const documents = await space.getDocuments();
      let documentsText = '';

      if (documents && documents.length > 0) {
        const texts = await Promise.all(
          documents.map(async (doc) => {
            const content = await fetchFileContent(app, doc);
            return `--- Document: ${doc.filename} ---\n${content}\n`;
          })
        );
        documentsText = texts.join('\n');
      }

      // 2b. Connect to LLM via plugin-ai
      const aiPlugin = app.pm.get('ai') as PluginAIServer;
      if (!aiPlugin) {
        throw new Error('Plugin AI is not available');
      }

      const { llmService, model, systemPrompt } = space.get();

      if (!llmService || !model) {
        throw new Error('LLM Service or model is missing in space configuration');
      }

      const serviceData = await aiPlugin.aiManager.getLLMService({ llmService, model });
      const provider = serviceData.provider;

      const messages = [];
      if (systemPrompt) {
        messages.push(new SystemMessage(systemPrompt));
      }

      const instruction = `Please generate an HTML user guide based on the following documents. Output ONLY valid HTML without Markdown blocks.\n\nDocuments:\n${documentsText}`;
      messages.push(new HumanMessage(instruction));

      const response = await provider.chatModel.invoke(messages);
      let rawHtml = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

      // Strip markdown code block if present
      rawHtml = rawHtml.replace(/^```html\s*/, '').replace(/```\s*$/, '');

      // 2c. Sanitize HTML output
      const cleanHtml = sanitizeHtml(rawHtml, {
        allowedTags: [
          'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
          'a', 'img', 'span', 'strong', 'em', 'code', 'pre', 'blockquote', 'br', 'hr'
        ],
        allowedAttributes: {
          'a': ['href', 'target'],
          'img': ['src', 'alt', 'width', 'height'],
          '*': ['style', 'class']
        },
        allowedStyles: {
          '*': {
            'color': [/^\#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, /^rgb/, /^rgba/],
            'background-color': [/^\#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, /^rgb/, /^rgba/],
            'text-align': [/^left$/, /^right$/, /^center$/, /^justify$/],
            'font-size': [/^\d+(?:px|em|%)$/]
          }
        }
      });

      // 2d. Save generated HTML
      await bgRepo.update({
        filterByTk,
        values: {
          generatedHtml: cleanHtml,
          status: 'completed',
        },
      });
    })();

    // Ensure background errors are caught and persisted
    bgPromise.catch(async (error) => {
      app.log.error('Build Guide Background Error', error);
      try {
        const bgRepo = db.getRepository('aiBuildGuideSpaces') as Repository;
        await bgRepo.update({
          filterByTk,
          values: {
            status: 'error',
            buildLog: error.message || String(error),
          },
        });
      } catch (updateErr) {
        app.log.error('Failed to persist build error status', updateErr);
      }
    });

    ctx.body = { status: 'building' };
  } catch (error) {
    app.log.error('Build Guide Error', error);
    await repository.update({
      filterByTk,
      values: {
        status: 'error',
        buildLog: error.message || String(error),
      },
    });
    ctx.throw(500, error.message || 'Error occurred during build');
  }

  await next();
}
