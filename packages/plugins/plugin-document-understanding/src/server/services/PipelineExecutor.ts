import { Database } from '@nocobase/database';
import { ExternalApiClient, FileInput } from './ExternalApiClient';
import { AsyncJobManager } from './AsyncJobManager';
import { PipelineDef, PipelineStepDef, JobState, EndpointDef } from '../types';

export interface ExecutionContext {
  input: Record<string, any>;
  files: FileInput[];
  stepResults: Record<string, any>;
  jobId: number;
}

export class PipelineExecutor {
  private db: Database;
  private apiClient: ExternalApiClient;
  private jobManager: AsyncJobManager;

  constructor(db: Database, apiClient: ExternalApiClient, jobManager: AsyncJobManager) {
    this.db = db;
    this.apiClient = apiClient;
    this.jobManager = jobManager;
  }

  private async resolveFile(urlOrPath: string, fieldName = 'file'): Promise<FileInput | null> {
    if (!urlOrPath || typeof urlOrPath !== 'string') return null;

    try {
      // 1. Check if it is a local path (starts with /uploads/ or storage/uploads/ or process.cwd() + ...)
      let isLocal = false;
      let absolutePath = '';

      if (urlOrPath.startsWith('/') || urlOrPath.startsWith('storage/') || urlOrPath.includes('/uploads/')) {
        let cleanedPath = urlOrPath;
        if (urlOrPath.startsWith('/')) {
          cleanedPath = urlOrPath.slice(1);
        }
        
        const pathOptions = [
          require('path').resolve(process.cwd(), cleanedPath),
          require('path').resolve(process.cwd(), 'storage', cleanedPath),
          require('path').resolve(process.cwd(), 'storage/uploads', cleanedPath.replace(/^uploads\//, ''))
        ];

        for (const p of pathOptions) {
          if (require('fs').existsSync(p) && require('fs').statSync(p).isFile()) {
            isLocal = true;
            absolutePath = p;
            break;
          }
        }
      }

      if (isLocal) {
        const fs = require('fs');
        const path = require('path');
        const buffer = fs.readFileSync(absolutePath);
        const filename = path.basename(absolutePath);
        
        let mimeLookup = (filePath: string) => 'application/octet-stream';
        try {
          const mime = require('mime-types');
          mimeLookup = (filePath: string) => mime.lookup(filePath) || 'application/octet-stream';
        } catch (e) {
          mimeLookup = (filePath: string) => {
            const ext = path.extname(filePath).toLowerCase();
            const map: Record<string, string> = {
              '.pdf': 'application/pdf',
              '.doc': 'application/msword',
              '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              '.xls': 'application/vnd.ms-excel',
              '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.txt': 'text/plain',
              '.json': 'application/json',
            };
            return map[ext] || 'application/octet-stream';
          };
        }

        const mimeType = mimeLookup(absolutePath);
        
        return {
          fieldName,
          buffer,
          filename,
          mimeType,
        };
      }

      // 2. Otherwise assume it's a remote URL and download it using axios
      if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
        const axios = require('axios');
        const path = require('path');
        
        const response = await axios.get(urlOrPath, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        
        let filename = 'file';
        const disposition = response.headers['content-disposition'];
        if (disposition && disposition.includes('filename=')) {
          const match = disposition.match(/filename="?([^";]+)"?/);
          if (match && match[1]) {
            filename = match[1];
          }
        } else {
          try {
            const urlObj = new URL(urlOrPath);
            const base = path.basename(urlObj.pathname);
            if (base && base.includes('.')) {
              filename = base;
            }
          } catch (e) {}
        }

        const contentType = response.headers['content-type'] || 'application/octet-stream';
        const mimeType = contentType.split(';')[0].trim();
        
        if (!filename.includes('.')) {
          let mimeExtension = (mime: string) => '';
          try {
            const mimeLib = require('mime-types');
            mimeExtension = (mime: string) => mimeLib.extension(mime) || '';
          } catch (e) {
            mimeExtension = (mime: string) => {
              const map: Record<string, string> = {
                'application/pdf': 'pdf',
                'application/msword': 'doc',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
                'application/vnd.ms-excel': 'xls',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
                'image/png': 'png',
                'image/jpeg': 'jpg',
                'text/plain': 'txt',
                'application/json': 'json',
              };
              return map[mime] || '';
            };
          }
          const ext = mimeExtension(mimeType);
          if (ext) {
            filename = `${filename}.${ext}`;
          }
        }

        return {
          fieldName,
          buffer,
          filename,
          mimeType,
        };
      }
    } catch (err: any) {
      console.error(`Failed to resolve file URL/path "${urlOrPath}":`, err.message);
    }

    return null;
  }

  async execute(pipelineId: number, input: Record<string, any>, files: FileInput[] = [], userId?: number): Promise<JobState> {
    const pipelineRepo = this.db.getRepository<any>('doc_understanding_pipelines');
    const jobsRepo = this.db.getRepository<any>('doc_understanding_jobs');

    const pipeline = await pipelineRepo.findOne({
      filter: { id: pipelineId },
      appends: ['steps', 'steps.endpoint'],
    });

    if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`);

    // Create Job
    const job = await jobsRepo.create({
      values: {
        pipelineId,
        status: 'pending',
        input,
        currentStep: 1, // 1-based ordering
        stepResults: {},
        externalTaskIds: {},
        startedAt: new Date(),
        createdById: userId,
      },
    });

    const resolvedFiles: FileInput[] = [];

    const tryAddFile = async (urlOrPath: string, fieldName = 'file') => {
      const resolved = await this.resolveFile(urlOrPath, fieldName);
      if (resolved) {
        resolvedFiles.push(resolved);
      }
    };

    // 1. Process files argument
    if (Array.isArray(files)) {
      for (const f of files) {
        if (f && typeof f === 'object') {
          if ((f as any).buffer) {
            resolvedFiles.push(f);
          } else if ((f as any).url) {
            await tryAddFile((f as any).url, (f as any).fieldName || 'file');
          }
        }
      }
    }

    // 2. Scan input for common file URL keys
    const urlFields = ['file_url', 'file_urls', 'file', 'files'];
    for (const key of urlFields) {
      const val = input[key];
      if (!val) continue;

      if (typeof val === 'string') {
        if (val.startsWith('http://') || val.startsWith('https://') || val.startsWith('/') || val.startsWith('storage/')) {
          await tryAddFile(val, 'file');
        } else if (val.includes(',')) {
          const urls = val.split(',').map(s => s.trim());
          for (const u of urls) {
            if (u.startsWith('http://') || u.startsWith('https://') || u.startsWith('/') || u.startsWith('storage/')) {
              await tryAddFile(u, 'file');
            }
          }
        }
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === 'string') {
            if (item.startsWith('http://') || item.startsWith('https://') || item.startsWith('/') || item.startsWith('storage/')) {
              await tryAddFile(item, 'file');
            }
          } else if (item && typeof item === 'object' && item.url) {
            await tryAddFile(item.url, 'file');
          }
        }
      } else if (val && typeof val === 'object' && val.url) {
        await tryAddFile(val.url, 'file');
      }
    }

    if (resolvedFiles.length === 0 && files && files.length > 0) {
      for (const f of files) {
        if ((f as any).buffer) {
          resolvedFiles.push(f);
        }
      }
    }

    const context: ExecutionContext = {
      input,
      files: resolvedFiles,
      stepResults: {},
      jobId: job.id,
    };

    // Sorting steps by order
    const steps = [...(pipeline.steps || [])].sort((a, b) => a.stepOrder - b.stepOrder);

    // Run steps (Synchronous part)
    this.runSteps(job, steps, context).catch(err => {
       console.error(`Background pipeline error for job ${job.id}`, err);
     });

    return job;
  }

  private async runSteps(job: JobState, steps: PipelineStepDef[], context: ExecutionContext, startFromOrder = 1) {
    const jobsRepo = this.db.getRepository<any>('doc_understanding_jobs');
    let currentOrder = startFromOrder;

    try {
      await jobsRepo.update({ filterByTk: job.id, values: { status: 'running' } });

      for (const step of steps) {
        if (step.stepOrder < startFromOrder) continue;

        context.jobId = job.id;
        currentOrder = step.stepOrder;

        await jobsRepo.update({ filterByTk: job.id, values: { currentStep: currentOrder } });

        if (!this.evaluateCondition(step.condition, context)) {
           continue; // Skip step
        }

        const mappedBody = this.resolveMapping(step.inputMapping || {}, context);
        let retries = step.onError === 'retry' ? (step.retryCount || 0) : 0;
        let success = false;
        let lastError = null;

        while (retries >= 0 && !success) {
          try {
            const fileFieldName = step.endpoint.fileFieldName || 'file';
            const mappedFiles = context.files ? context.files.map(f => ({
              ...f,
              fieldName: fileFieldName
            })) : [];

            const result = await this.apiClient.call({
              endpoint: step.endpoint,
              body: mappedBody,
              files: mappedFiles,
            });

            if (step.endpoint.executionMode === 'sync') {
              context.stepResults[step.outputAlias || step.stepOrder.toString()] = result.data;
              success = true;
            } else if (step.endpoint.executionMode === 'polling') {
              // Extract taskId from result based on pollTaskIdField
              const taskIdField = step.endpoint.pollTaskIdField || 'task_id';
              const taskId = this.getNestedValue(result.data, taskIdField);
              
              if (!taskId) throw new Error(`Polling taskId not found in field ${taskIdField}`);
              
              let externalTaskIds = job.externalTaskIds || {};
              externalTaskIds[step.stepOrder.toString()] = taskId;
              
              await jobsRepo.update({
                filterByTk: job.id,
                values: { status: 'polling', externalTaskIds }
              });

              await this.jobManager.startPolling(job.id, step.endpoint, taskId);
              
              // Halt execution. Polling callback will resume from next step.
              return;
            } else if (step.endpoint.executionMode === 'webhook') {
              // Wait for webhook 
              const taskIdField = step.endpoint.pollTaskIdField || 'task_id';
              const taskId = this.getNestedValue(result.data, taskIdField);
              let externalTaskIds = job.externalTaskIds || {};
              externalTaskIds[step.stepOrder.toString()] = taskId;

              await jobsRepo.update({
                filterByTk: job.id,
                values: { status: 'polling', externalTaskIds }
              });

              // End execution. Webhook will resume.
              return;
            }

          } catch (err: any) {
            lastError = err;
            retries--;
          }
        }

        if (!success) {
          if (step.onError === 'fail') {
             throw lastError || new Error(`Step ${step.name} failed`);
          }
          // if 'skip', we continue the loop
        }
      }

      // If loop completes without being halted for async
      await this.finishJob(job.id, context);

    } catch (err: any) {
      await jobsRepo.update({
        filterByTk: job.id,
        values: { status: 'failed', error: err.message, completedAt: new Date() }
      });
    }
  }

  async resumeFromStep(jobId: number, asyncResult: any) {
    const jobsRepo = this.db.getRepository<any>('doc_understanding_jobs');
    const pipelineRepo = this.db.getRepository<any>('doc_understanding_pipelines');
    
    const job = await jobsRepo.findOne({ filterByTk: jobId });
    if (!job) throw new Error(`Job ${jobId} not found`);

    const pipeline = await pipelineRepo.findOne({
      filter: { id: job.pipelineId },
      appends: ['steps', 'steps.endpoint'],
    });

    if (!pipeline) throw new Error(`Pipeline not found for job ${jobId}`);

    const steps = [...(pipeline.steps || [])].sort((a, b) => a.stepOrder - b.stepOrder);
    const step = steps.find(s => s.stepOrder === job.currentStep);
    
    if (step) {
       job.stepResults = job.stepResults || {};
       job.stepResults[step.outputAlias || step.stepOrder.toString()] = asyncResult;
       
       await jobsRepo.update({
         filterByTk: jobId,
         values: { stepResults: job.stepResults } // updating stepResults json
       });
    }

    const context: ExecutionContext = {
       input: job.input,
       files: [], // Files cannot easily persist across webhook unless stored in bucket. For now assume next steps use only json.
       stepResults: job.stepResults,
       jobId: job.id,
    };

    // resume from next step
    this.runSteps(job, steps, context, job.currentStep + 1).catch(err => {
      console.error(`Failed executing step ${job.currentStep + 1} for job ${job.id}`, err);
    });
  }

  private async finishJob(jobId: number, context: ExecutionContext) {
    const jobsRepo = this.db.getRepository<any>('doc_understanding_jobs');
    const pipelineRepo = this.db.getRepository<any>('doc_understanding_pipelines');
    const job = await jobsRepo.findOne({ filterByTk: jobId });
    if (!job) return;

    const pipeline = await pipelineRepo.findOne({ filter: { id: job.pipelineId } });
    if (!pipeline) return;

    const finalResult = pipeline.outputMapping ? this.resolveMapping(pipeline.outputMapping, context) : context.stepResults;

    await jobsRepo.update({
      filterByTk: jobId,
      values: {
        status: 'completed',
        stepResults: context.stepResults,
        finalResult,
        completedAt: new Date(),
      }
    });
  }

  private resolveMapping(mapping: Record<string, string>, context: ExecutionContext): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(mapping)) {
      if (typeof value === 'string') {
        if (value.startsWith('$input.')) {
           result[key] = this.getNestedValue(context.input, value.replace('$input.', ''));
        } else if (value.startsWith('$step[')) {
           const match = value.match(/\$step\[(.*?)\]\.response\.(.*)/);
           if (match) {
             const stepKey = match[1];
             const path = match[2];
             const stepResult = context.stepResults[stepKey];
             result[key] = this.getNestedValue(stepResult, path);
           } else {
             result[key] = value; 
           }
        } else if (value === '$files') {
           // special case: mapping wants files. Not mapped here as form data handles files via input.files.
        } else {
           result[key] = value;
        }
      } else {
        result[key] = value; // copy raw if not string mapping
      }
    }
    return result;
  }

  private evaluateCondition(condition: any, context: ExecutionContext): boolean {
    if (!condition) return true;
    
    const resolveValue = (v: any) => {
      if (typeof v === 'string' && v.startsWith('$')) {
         // Resolve simple $ expressions
         if (v.startsWith('$step[')) {
            const match = v.match(/\$step\[(.*?)\]\.response\.(.*)/);
            if (match) return this.getNestedValue(context.stepResults[match[1]], match[2]);
         }
      }
      return v;
    };

    const fieldVal = resolveValue(condition.field);
    const val = resolveValue(condition.value);

    switch (condition.op) {
      case 'eq': return fieldVal === val;
      case 'neq': return fieldVal !== val;
      case 'gt': return fieldVal > val;
      case 'gte': return fieldVal >= val;
      case 'lt': return fieldVal < val;
      case 'lte': return fieldVal <= val;
      case 'in': return Array.isArray(val) && val.includes(fieldVal);
      case 'contains': return typeof fieldVal === 'string' && fieldVal.includes(String(val));
      default: return false;
    }
  }

  private getNestedValue(obj: any, path: string): any {
    if (!obj) return obj;
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
  }
}
