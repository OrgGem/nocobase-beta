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

    const context: ExecutionContext = {
      input,
      files,
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
            const result = await this.apiClient.call({
              endpoint: step.endpoint,
              body: mappedBody,
              files: context.files,
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
