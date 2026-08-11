import type { Context } from '@nocobase/actions';
import type { AttachmentLike } from './internal-parser-registry';
import type { OcrEngineConfig } from './document-parse.types';

type LlmProvider = {
  invoke(context: { messages: Array<{ role: 'system' | 'user'; content: unknown }> }): Promise<{ content?: unknown }>;
};

export type VisionAiManager = {
  getLLMService(options: { llmService: string; model: string }): Promise<{ provider: LlmProvider }>;
};

export class VisionOcrEngine {
  readonly engine = 'vision-ocr' as const;

  constructor(private readonly getAiManager: () => VisionAiManager | null) {}

  async parseBuffer(
    _ctx: Context,
    buffer: Buffer,
    attachment: AttachmentLike,
    config: OcrEngineConfig,
    _timeoutMs: number,
  ): Promise<string | null> {
    if (config.kind !== 'llm-vision' || !attachment.mimetype?.startsWith('image/')) {
      return null;
    }

    const aiManager = this.getAiManager();
    if (!aiManager) {
      return null;
    }

    const { provider } = await aiManager.getLLMService({
      llmService: config.serviceId,
      model: config.model,
    });
    const response = await provider.invoke({
      messages: [
        {
          role: 'system',
          content: 'Transcribe all visible text from the image accurately. Return Markdown only, without commentary.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${attachment.mimetype};base64,${buffer.toString('base64')}` },
            },
          ],
        },
      ],
    });

    return typeof response.content === 'string' && response.content.trim() ? response.content.trim() : null;
  }
}
