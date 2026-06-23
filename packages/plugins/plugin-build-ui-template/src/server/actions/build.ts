import { Context, Next } from '@nocobase/actions';
import { Repository } from '@nocobase/database';
import type { Application } from '@nocobase/server';
// @ts-ignore
import { PluginAIServer } from '@nocobase/plugin-ai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { uid } from '@nocobase/utils';

export const WORKER_JOB_BUILD_UI_TEMPLATE_PROCESS = 'build-ui-template:process';
const BUILD_TEMPLATE_QUEUE_CHANNEL = 'plugin-build-ui-template.build';
const BUILD_TEMPLATE_WORKER_ALIASES = [BUILD_TEMPLATE_QUEUE_CHANNEL];
const BUILD_TEMPLATE_QUEUE_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_TEMPLATE_QUEUE_POLL_INTERVAL_MS = 5000;
const BUILD_TEMPLATE_QUEUE_WAKE_CHANNEL = 'plugin-build-ui-template.build.wake';

type BuildQueueMessage = {
  spaceId: string;
  runId: string;
  queuedAt?: string;
};

type BuildRunContext = {
  spaceId: string;
  runId: string;
};

let buildQueueTimer: NodeJS.Timeout | null = null;
let buildQueueKickTimer: NodeJS.Timeout | null = null;
let buildQueueProcessing = false;
let buildQueueWakeHandler: ((message?: any) => Promise<void>) | null = null;

class StaleBuildRunError extends Error {
  constructor(spaceId: string, runId: string) {
    super(`Build run ${runId} for space ${spaceId} is no longer active`);
    this.name = 'StaleBuildRunError';
  }
}

// 1. Triggers building
export async function build(ctx: Context, next: Next) {
  const { filterByTk } = ctx.action.params;
  if (!filterByTk) {
    return ctx.throw(400, 'spaceId is required');
  }

  const spaceRepo = ctx.db.getRepository('aiBuildUiTemplateSpaces');
  const space = await spaceRepo.findById(filterByTk);
  if (!space) {
    return ctx.throw(404, 'Space not found');
  }

  const runId = uid();
  const now = new Date();

  await spaceRepo.update({
    filterByTk,
    values: {
      status: 'building',
      buildPhase: 'queued',
      buildRunId: runId,
      buildQueuedAt: now,
      buildLog: 'Build requested, queuing job...',
    },
    transaction: ctx.transaction,
  });

  ctx.body = {
    result: 'ok',
    runId,
  };

  await next();

  // Push to local event queue & wake worker
  const app = ctx.app;
  setTimeout(() => {
    enqueueLocalBuild(app, { spaceId: String(filterByTk), runId });
  }, 100);
}

// 2. Queue Mechanics
function enqueueLocalBuild(app: Application, message: BuildQueueMessage) {
  app.log?.info(`[plugin-build-ui-template] Enqueued build ${message.runId} for space "${message.spaceId}"`);
  publishBuildQueueWake(app, message);
}

function isBuildTemplateWorker(app: Application) {
  return app.serving(WORKER_JOB_BUILD_UI_TEMPLATE_PROCESS) || workerModeServesBuildTemplate();
}

function workerModeServesBuildTemplate() {
  const workerMode = process.env.WORKER_MODE || '';
  const workerModes = workerMode
    .split(',')
    .map((mode) => mode.trim())
    .filter(Boolean);

  return workerModes.some((mode) => {
    if (mode === '*' || mode === 'worker' || mode === 'task' || mode === WORKER_JOB_BUILD_UI_TEMPLATE_PROCESS) {
      return true;
    }
    return BUILD_TEMPLATE_WORKER_ALIASES.includes(mode);
  });
}

async function publishBuildQueueWake(app: Application, message?: BuildQueueMessage) {
  try {
    await (app as any).pubSubManager?.publish?.(
      BUILD_TEMPLATE_QUEUE_WAKE_CHANNEL,
      { spaceId: message?.spaceId, runId: message?.runId },
      { skipSelf: !isBuildTemplateWorker(app) },
    );
  } catch (error: any) {
    app.log?.debug(`[plugin-build-ui-template] Wake publish skipped: ${error?.message || error}`);
  }
}

export function registerBuildTemplateQueue(app: Application) {
  if (!isBuildTemplateWorker(app)) {
    app.log?.debug?.('[plugin-build-ui-template] Queue processor disabled on non-worker node');
    return;
  }
  if (buildQueueTimer) return;

  buildQueueWakeHandler = async () => {
    scheduleBuildQueueTick(app, 0);
  };

  const subscribe = (app as any).pubSubManager?.subscribe?.(BUILD_TEMPLATE_QUEUE_WAKE_CHANNEL, buildQueueWakeHandler);
  if (subscribe?.catch) {
    subscribe.catch((error: any) => {
      app.log?.debug(`[plugin-build-ui-template] Wake subscribe skipped: ${error?.message || error}`);
    });
  }

  buildQueueTimer = setInterval(() => scheduleBuildQueueTick(app, 0), BUILD_TEMPLATE_QUEUE_POLL_INTERVAL_MS);
  (buildQueueTimer as any).unref?.();
  scheduleBuildQueueTick(app, 1000);
  app.log?.info?.(
    `[plugin-build-ui-template] Queue processor started (interval ${BUILD_TEMPLATE_QUEUE_POLL_INTERVAL_MS}ms)`,
  );
}

export function unregisterBuildTemplateQueue(app: Application) {
  if (buildQueueTimer) {
    clearInterval(buildQueueTimer);
    buildQueueTimer = null;
  }
  if (buildQueueKickTimer) {
    clearTimeout(buildQueueKickTimer);
    buildQueueKickTimer = null;
  }
  if (buildQueueWakeHandler) {
    (app as any).pubSubManager
      ?.unsubscribe?.(BUILD_TEMPLATE_QUEUE_WAKE_CHANNEL, buildQueueWakeHandler)
      .catch(() => undefined);
    buildQueueWakeHandler = null;
  }
  buildQueueProcessing = false;
}

function scheduleBuildQueueTick(app: Application, delayMs: number) {
  if (buildQueueKickTimer) return;
  buildQueueKickTimer = setTimeout(() => {
    buildQueueKickTimer = null;
    runBuildQueueTick(app).catch((error) => {
      app.log?.error('[plugin-build-ui-template] Queue tick failed', error);
    });
  }, delayMs);
  (buildQueueKickTimer as any).unref?.();
}

async function runBuildQueueTick(app: Application) {
  if (buildQueueProcessing) return;
  buildQueueProcessing = true;

  try {
    const spaceRepo = app.db.getRepository('aiBuildUiTemplateSpaces');
    const queuedSpaces = await spaceRepo.find({
      filter: {
        status: 'building',
        buildPhase: 'queued',
      },
      sort: ['buildQueuedAt'],
      limit: 1,
    });

    if (!queuedSpaces || queuedSpaces.length === 0) {
      return;
    }

    const space = queuedSpaces[0];
    const run: BuildRunContext = {
      spaceId: String(space.get('id')),
      runId: String(space.get('buildRunId')),
    };

    app.log?.info(`[plugin-build-ui-template] Starting async build for space ${run.spaceId}`);

    // Claim run
    const [affected] = await spaceRepo.update({
      filter: {
        id: run.spaceId,
        status: 'building',
        buildPhase: 'queued',
        buildRunId: run.runId,
      },
      values: {
        buildPhase: 'running',
        buildStartedAt: new Date(),
        buildHeartbeatAt: new Date(),
      },
    });

    if (affected <= 0) {
      app.log?.warn(`[plugin-build-ui-template] Failed to claim build run ${run.runId}`);
      return;
    }

    // Keep updating heartbeat during the build
    const heartbeatTimer = setInterval(() => {
      spaceRepo
        .update({
          filter: { id: run.spaceId, buildRunId: run.runId },
          values: { buildHeartbeatAt: new Date() },
        })
        .catch(() => undefined);
    }, 10000);

    try {
      await executeBuild(app, run);
    } catch (err: any) {
      app.log?.error(`[plugin-build-ui-template] Build ${run.runId} failed`, err);
      await spaceRepo
        .update({
          filter: { id: run.spaceId, buildRunId: run.runId },
          values: {
            status: 'error',
            buildPhase: 'error',
            buildLog: `Generation failed: ${err.message || String(err)}`,
          },
        })
        .catch(() => undefined);
    } finally {
      clearInterval(heartbeatTimer);
    }
  } finally {
    buildQueueProcessing = false;
  }
}

export async function recoverInterruptedBuilds(app: Application) {
  if (!isBuildTemplateWorker(app)) {
    return;
  }

  const spaceRepo = app.db.getRepository('aiBuildUiTemplateSpaces');
  const runningSpaces = await spaceRepo.find({
    filter: {
      status: 'building',
      buildPhase: 'running',
    },
  });

  for (const space of runningSpaces) {
    const spaceId = String(space.get('id'));
    app.log?.info(`[plugin-build-ui-template] Re-queuing interrupted build for space ${spaceId}`);
    await spaceRepo.update({
      filterByTk: spaceId,
      values: {
        buildPhase: 'queued',
        buildQueuedAt: new Date(),
        buildLog: 'System restarted, re-queuing build job...',
      },
    });
  }
}

// 3. Generation Logic
async function executeBuild(app: Application, run: BuildRunContext) {
  const spaceRepo = app.db.getRepository('aiBuildUiTemplateSpaces');
  const space = await spaceRepo.findById(run.spaceId);
  if (!space) throw new Error('Space not found');

  const { title, llmService, model, systemPrompt, promptRequirements, type, targetCollection } = space.get();
  if (!llmService || !model) throw new Error('LLM Service or model is missing in space settings');

  // Load collection metadata
  await updateSpace(app, run, 'preparing', 'Loading target collection metadata...');
  let fieldsMeta = '';
  if (targetCollection) {
    const collection = app.db.getCollection(targetCollection);
    if (collection) {
      const fields = collection.fields;
      fieldsMeta = Array.from(fields.values())
        .map((f: any) => `- Name: ${f.name}, Type: ${f.type}, Title: ${f.options?.title || f.name}`)
        .join('\n');
    }
  }

  await updateSpace(app, run, 'generating', 'AI is generating UI flow models...');

  const aiPlugin = app.pm.get('ai') as PluginAIServer;
  if (!aiPlugin) throw new Error('Plugin AI is not available');

  const serviceData = await aiPlugin.aiManager.getLLMService({ llmService, model });
  const provider = serviceData.provider;

  // Prompts LLM for layout
  const messages = [];
  if (systemPrompt) {
    messages.push(new SystemMessage(systemPrompt));
  } else {
    messages.push(
      new SystemMessage(
        `You are a senior UI UX developer specializing in NocoBase V2. 
        You construct professional block layouts using nested JSON FlowModels.
        
        Rules:
        - Return ONLY a valid JSON structure representing the root FlowModel. No markdown code fences, no explanations.
        - The root object must contain "use" representing the block type. Common types: "EditFormModel", "DetailsBlockModel", "TableBlockModel", "GridCardBlockModel".
        - The layout is recursive. Sub-models should be defined in a "subModels" object, mapped by subKey.
        - Every subModel must have a unique "uid" placeholder (you can output temporary strings like "node_1", "node_2").
        - Always include standard grid layouts: a Form or Details block should have a subModel with key "grid" using "ReferenceFormGridModel" or "FormGridModel" containing a grid of fields.
        - Ensure correct collection binding by using target fields provided in the prompt context.
        `,
      ),
    );
  }

  let prompt = `Create a beautiful UI ${type === 'popup' ? 'Popup' : 'Block'} template for collection "${
    targetCollection || 'unknown'
  }".
  Requirements: ${promptRequirements || 'Create a clean, functional dashboard/form layout'}
  `;

  if (fieldsMeta) {
    prompt += `\nAvailable Database Fields for collection "${targetCollection}":\n${fieldsMeta}`;
  }

  messages.push(new HumanMessage(prompt));

  const response = await provider.chatModel.invoke(messages);
  const rawText = stripThink(toPlainText(response.content));

  await updateSpace(app, run, 'saving', 'Parsing and storing the new FlowModel...');

  // Parse layout tree - Highly resilient JSON boundary parsing
  const cleanJsonText = stripFence(rawText);
  const jsonStart = cleanJsonText.indexOf('{');
  const jsonEnd = cleanJsonText.lastIndexOf('}');
  const jsonText = jsonStart >= 0 && jsonEnd > jsonStart ? cleanJsonText.slice(jsonStart, jsonEnd + 1) : cleanJsonText;

  let parsedModel: any;
  try {
    parsedModel = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Failed to parse AI output as JSON: ${rawText.slice(0, 300)}`);
  }

  // Set randomized UIDs to make them uniquely saveable
  const uidMap: Record<string, string> = {};
  const assignUids = (node: any) => {
    if (!node || typeof node !== 'object') return;
    const oldUid = node.uid || node['x-uid'] || uid();
    const newUid = uid();
    uidMap[oldUid] = newUid;
    node.uid = newUid;
    node['x-uid'] = newUid;

    if (node.subModels && typeof node.subModels === 'object') {
      for (const val of Object.values(node.subModels)) {
        const items = Array.isArray(val) ? val : [val];
        for (const item of items) {
          assignUids(item);
        }
      }
    }
  };
  assignUids(parsedModel);

  // Highly robust recursive replacement of temporary placeholder UIDs inside nested objects
  const replacePlaceholderUids = (val: any): any => {
    if (typeof val === 'string') {
      return uidMap[val] || val;
    }
    if (Array.isArray(val)) {
      return val.map(replacePlaceholderUids);
    }
    if (val && typeof val === 'object') {
      const next: any = {};
      for (const [k, v] of Object.entries(val)) {
        next[k] = replacePlaceholderUids(v);
      }
      return next;
    }
    return val;
  };
  parsedModel = replacePlaceholderUids(parsedModel);

  // Set parent relation options
  const configureRelations = (node: any, parentUid?: string, subKey?: string, subType?: string) => {
    if (!node || typeof node !== 'object') return;
    if (parentUid && subKey) {
      node.parentId = parentUid;
      node.subKey = subKey;
      node.subType = subType || 'object';
    }
    if (node.subModels && typeof node.subModels === 'object') {
      for (const [key, val] of Object.entries(node.subModels)) {
        const isArray = Array.isArray(val);
        const items = isArray ? val : [val];
        items.forEach((item: any, idx: number) => {
          configureRelations(item, node.uid, key, isArray ? 'array' : 'object');
          if (isArray) {
            item.sortIndex = idx + 1;
          }
        });
      }
    }
  };
  configureRelations(parsedModel);

  // Save tree to database
  const flowRepo = app.db.getRepository('flowModels') as any;
  if (!flowRepo || typeof flowRepo.insertModel !== 'function') {
    throw new Error('FlowModelRepository or insertModel is not available. Ensure plugin-flow-engine is enabled.');
  }

  const savedModel = await flowRepo.insertModel(parsedModel);
  const targetUid = savedModel?.uid || parsedModel.uid;

  // Create UI template record
  const templateRepo = app.db.getRepository('flowModelTemplates');
  const tplUid = uid();
  await templateRepo.create({
    values: {
      uid: tplUid,
      name: `${title || 'AI'} Template (${type})`,
      description: `AI-generated template: ${promptRequirements?.slice(0, 100) || ''}`,
      targetUid,
      useModel: parsedModel.use || 'BlockModel',
      type: type || 'block',
      collectionName: targetCollection || undefined,
    },
  });

  await spaceRepo.update({
    filterByTk: run.spaceId,
    values: {
      status: 'completed',
      buildPhase: 'completed',
      templateUid: tplUid,
      buildLog: `Template generated successfully! Target root FlowModel UID: ${targetUid}`,
    },
  });
}

async function updateSpace(app: Application, run: BuildRunContext, phase: string, log: string) {
  const spaceRepo = app.db.getRepository('aiBuildUiTemplateSpaces');
  await spaceRepo
    .update({
      filter: { id: run.spaceId, buildRunId: run.runId },
      values: {
        buildPhase: phase,
        buildLog: log,
      },
    })
    .catch(() => undefined);
}

function toPlainText(value: unknown) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item: any) => item?.text || item?.content || '')
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    return (value as any).text || (value as any).content || JSON.stringify(value);
  }
  return String(value);
}

function stripThink(text: string) {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
}

function stripFence(text: string) {
  return text
    .replace(/^```(?:json|markdown|md)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}
