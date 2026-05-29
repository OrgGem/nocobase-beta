import { PlanApprovalCard } from './PlanApprovalCard';

export async function registerOrchestratorCards(app: any) {
  const toolsManager = app.aiManager?.toolsManager;
  if (!toolsManager) return;
  toolsManager.registerTools('orchestrator_execute_plan', { ui: { card: PlanApprovalCard } });
}
