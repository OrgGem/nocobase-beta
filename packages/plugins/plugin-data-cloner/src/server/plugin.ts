import { Plugin } from '@nocobase/server';
import { validateAction, startCloneAction, pauseCloneAction } from './actions/clone';
import { CloneEngineService } from './services/CloneEngineService';

export class PluginDataClonerServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {
    this.db.import({
      directory: __dirname + '/collections',
    });
  }

  async load() {
    this.app.resource({
      name: 'dataCloner',
      actions: {
        validate: validateAction,
        start: startCloneAction,
        pause: pauseCloneAction
      }
    });

    // Auto resume running tasks when server boots up
    this.app.on('afterStart', async () => {
      const cloneTaskRepo = this.db.getRepository('clone_tasks');
      const runningTasks = await cloneTaskRepo.find({ filter: { status: 'running' } });
      
      const engine = new CloneEngineService(this.app);
      for (const task of runningTasks) {
        this.app.logger.info(`Auto-resuming task ${task.id} after server restart`);
        engine.startTask(task.id).catch(async (err) => {
          this.app.logger.error(`Failed to auto-resume task ${task.id}:`, err);
          await engine.updateTaskStatus(task.id, 'error');
        });
      }
    });
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginDataClonerServer;
