import { PlanApprovalCard } from './PlanApprovalCard';

const registerToolCard = (toolsManager: any, name: string) => {
  try {
    toolsManager.registerTools(name, { ui: { card: PlanApprovalCard } });
  } catch (err: unknown) {
    if (!(err instanceof Error) || !err.message.includes('override existing keys')) {
      throw err;
    }
  }
};

export async function registerOrchestratorCards(app: any) {
  const toolsManager = app.aiManager?.toolsManager;
  if (!toolsManager) return;
  registerToolCard(toolsManager, 'orchestrator_execute_plan');
}
