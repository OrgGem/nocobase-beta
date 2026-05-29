import React from 'react';
import { Alert, Button, Card, Input, List, Space, Tag, Typography, message } from 'antd';
import { ToolsUIProperties, useAPIClient } from '@nocobase/client';

const { Paragraph, Text } = Typography;

const extractData = (response: any) => response?.data?.data ?? response?.data ?? response;

const summarizeArgsPlan = (plan: any[]) =>
  (Array.isArray(plan) ? plan : []).map((step, index) => ({
    id: step.id || step.planKey || index,
    planKey: step.planKey || step.key || step.id || `step_${index + 1}`,
    title: step.title || `Step ${index + 1}`,
    description: step.description || '',
    type: step.type || 'tool',
    target: step.target || '',
    dependsOn: step.dependsOn || [],
  }));

export const PlanApprovalCard: React.FC<ToolsUIProperties> = ({ toolCall, decisions }) => {
  const api = useAPIClient();
  const rawArgs = (toolCall.args as Record<string, any>) || {};
  const runId = rawArgs.runId;
  const [detail, setDetail] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [feedback, setFeedback] = React.useState('');

  const interrupted = toolCall.invokeStatus === 'init' || toolCall.invokeStatus === 'interrupted';

  React.useEffect(() => {
    if (!interrupted || !runId) return;
    let mounted = true;
    setLoading(true);
    api
      .request({
        url: 'agentLoops:get',
        params: { filterByTk: runId },
      })
      .then((response) => {
        if (mounted) setDetail(extractData(response));
      })
      .catch(() => {
        if (mounted) setDetail(null);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [api, interrupted, runId]);

  if (!interrupted) {
    return null;
  }

  const run = detail?.run || {};
  const steps = summarizeArgsPlan(detail?.steps || rawArgs.plan || []);
  const goal = run.goal || rawArgs.goal || '';

  const rejectPlan = async () => {
    if (!runId) {
      await decisions.reject('missing_run_id');
      return;
    }
    setSubmitting(true);
    try {
      await api.request({
        url: 'agentLoops:rejectPlan',
        method: 'post',
        data: { runId, reason: feedback || 'Plan rejected by user.' },
      });
      await decisions.reject(JSON.stringify({ reason: 'plan_rejected', runId, feedback }));
    } catch (error: any) {
      message.error(error?.message || 'Failed to reject plan');
    } finally {
      setSubmitting(false);
    }
  };

  const requestChanges = async () => {
    if (!feedback.trim()) {
      message.warning('Add feedback before requesting changes.');
      return;
    }
    setSubmitting(true);
    try {
      await api.request({
        url: 'agentLoops:requestPlanChanges',
        method: 'post',
        data: { runId, feedback },
      });
      await decisions.reject(JSON.stringify({ reason: 'changes_requested', runId, feedback }));
    } catch (error: any) {
      message.error(error?.message || 'Failed to request plan changes');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card size="small" style={{ marginTop: 8 }}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="Review orchestrator plan"
          description="Execution starts only after you approve this plan."
        />

        <Space size={8} wrap>
          {runId && <Tag color="blue">Run #{runId}</Tag>}
          <Tag color="purple">Plan v{run.planVersion || rawArgs.planVersion || 1}</Tag>
          <Tag color={run.approvalStatus === 'pending' ? 'gold' : 'default'}>
            {run.approvalStatus || 'pending'}
          </Tag>
          {run.metadata?.harnessTag && <Tag>{run.metadata.harnessTag}</Tag>}
        </Space>

        {goal && (
          <Paragraph style={{ marginBottom: 0 }}>
            <Text strong>Goal: </Text>
            {goal}
          </Paragraph>
        )}

        <List
          size="small"
          loading={loading}
          dataSource={steps}
          locale={{ emptyText: 'No plan steps found.' }}
          renderItem={(step: any, index) => (
            <List.Item>
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Space size={8} wrap>
                  <Text strong>
                    {index + 1}. {step.title}
                  </Text>
                  <Tag>{step.type}</Tag>
                  {step.target && <Tag color="green">{step.target}</Tag>}
                </Space>
                {step.description && <Text type="secondary">{step.description}</Text>}
                {step.dependsOn?.length > 0 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Depends on: {step.dependsOn.join(', ')}
                  </Text>
                )}
              </Space>
            </List.Item>
          )}
        />

        <Input.TextArea
          rows={3}
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder="Optional rejection reason or requested changes"
        />

        <Space wrap>
          <Button type="primary" loading={submitting} onClick={() => decisions.approve()}>
            Accept & Run
          </Button>
          <Button loading={submitting} onClick={requestChanges}>
            Request changes
          </Button>
          <Button danger loading={submitting} onClick={rejectPlan}>
            Reject
          </Button>
        </Space>
      </Space>
    </Card>
  );
};
