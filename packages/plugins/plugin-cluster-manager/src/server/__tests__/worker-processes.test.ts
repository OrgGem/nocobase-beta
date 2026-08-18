import {
  getCommonWorkerProcesses,
  isWorkerOnlyMode,
  normalizeWorkerMode,
  resolveWorkerProcessName,
  workerModeServesProcess,
} from '../../shared/worker-processes';
import { getNodeRoleFrom } from '../utils/node';

describe('worker process resolver', () => {
  it('normalizes process keys and queue aliases', () => {
    expect(normalizeWorkerMode('workflow.pendingExecution, plugin-git-manager.review')).toBe(
      'workflow:process,git-review:process',
    );
    expect(normalizeWorkerMode('main:plugin-build-guide-block:build:queue')).toBe('build-guide:process');
    expect(normalizeWorkerMode('file-preview-auth.ocr.queue')).toBe('file-preview-auth:ocr');
  });

  it('lets wildcard win when mixed with explicit processes', () => {
    expect(normalizeWorkerMode('workflow:process,*,git-review:process')).toBe('*');
    expect(workerModeServesProcess('*,workflow:process', 'notification-manager.send')).toBe(true);
  });

  it('routes app and worker modes using NocoBase worker semantics', () => {
    expect(isWorkerOnlyMode('!')).toBe(false);
    expect(isWorkerOnlyMode('workflow:process')).toBe(true);
    expect(isWorkerOnlyMode('workflow.pendingExecution')).toBe(true);
    expect(workerModeServesProcess('workflow.pendingExecution', 'workflow:process')).toBe(true);
    expect(workerModeServesProcess('workflow:process', 'plugin-git-manager.review')).toBe(false);
    expect(workerModeServesProcess('file-preview-auth.ocr.queue', 'file-preview-auth:ocr')).toBe(true);
  });

  it('keeps unknown custom process keys stable', () => {
    expect(resolveWorkerProcessName('custom-plugin:process')).toBe('custom-plugin:process');
    expect(workerModeServesProcess('custom-plugin:process', 'custom-plugin:process')).toBe(true);
  });

  it('registers the agent loop worker so worker stacks can serve it', () => {
    expect(resolveWorkerProcessName('agent-loop.worker')).toBe('agent-loop:worker');
    expect(workerModeServesProcess('agent-loop:worker', 'agent-loop:worker')).toBe(true);
    expect(workerModeServesProcess('agent-loop.worker', 'agent-loop:worker')).toBe(true);
    expect(workerModeServesProcess('workflow:process', 'agent-loop:worker')).toBe(false);
    expect(getCommonWorkerProcesses().some((definition) => definition.name === 'agent-loop:worker')).toBe(true);
  });

  it('lets explicit APP_ROLE override worker mode for local node classification', () => {
    expect(getNodeRoleFrom({ appRole: 'app', workerMode: '*' })).toBe('app');
    expect(getNodeRoleFrom({ appRole: 'worker', workerMode: '!' })).toBe('worker');
    expect(getNodeRoleFrom({ appRole: 'sandbox', workerMode: '!' })).toBe('sandbox');
  });
});
