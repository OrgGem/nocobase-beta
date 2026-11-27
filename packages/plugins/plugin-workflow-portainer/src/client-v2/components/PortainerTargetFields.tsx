/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { WorkflowVariableWrapper } from '@nocobase/plugin-workflow/client-v2';
import { Button, Flex, Form, InputNumber, Select, Tag } from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PORTAINER_RESOURCE } from '../../shared/constants';
import { isWorkflowVariableValue, toFiniteNumber } from '../../shared/env';
import type { PortainerEndpointSummary, PortainerInstanceSummary, PortainerStackSummary } from '../../shared/types';
import { useT } from '../locale';

export interface StaticStackContext {
  instanceId?: number;
  stack?: PortainerStackSummary;
}

export function PortainerInstanceField() {
  const t = useT();
  const api = useApp().apiClient;
  const [instances, setInstances] = useState<PortainerInstanceSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const loadInstances = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request<{ data?: PortainerInstanceSummary[] }>({
        url: `${PORTAINER_RESOURCE}:listInstances`,
        method: 'get',
      });
      setInstances(Array.isArray(res?.data?.data) ? res.data.data : []);
    } catch {
      setInstances([]);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadInstances();
  }, [loadInstances]);

  const options = useMemo(
    () =>
      instances.map((inst) => ({
        value: inst.id,
        label: inst.isDefault ? `${inst.name} (${t('Default')})` : inst.name,
      })),
    [instances, t],
  );

  return (
    <Form.Item
      name={['config', 'instanceId']}
      label={t('Portainer instance')}
      extra={t('Leave empty to use the default enabled Portainer instance, or bind a workflow variable.')}
    >
      <WorkflowVariableWrapper<number>
        render={({ value, onChange }) => (
          <Select
            allowClear
            loading={loading}
            value={toFiniteNumber(value)}
            onChange={(nextVal) => onChange?.(typeof nextVal === 'number' ? nextVal : null)}
            options={options}
            placeholder={t('Default Portainer instance')}
            style={{ width: '100%' }}
          />
        )}
      />
    </Form.Item>
  );
}

export function PortainerTargetFields({
  onStackContextChange,
}: {
  onStackContextChange?: (ctx: StaticStackContext) => void;
}) {
  const t = useT();
  const api = useApp().apiClient;
  const form = Form.useFormInstance();

  const watchedInstanceId = Form.useWatch(['config', 'instanceId'], form) as string | number | null | undefined;
  const watchedEndpointId = Form.useWatch(['config', 'endpointId'], form) as string | number | null | undefined;
  const watchedStackId = Form.useWatch(['config', 'stackId'], form) as string | number | null | undefined;

  const instanceIsVar = isWorkflowVariableValue(watchedInstanceId);
  const endpointIsVar = isWorkflowVariableValue(watchedEndpointId);
  const stackIsVar = isWorkflowVariableValue(watchedStackId);

  const numericInstanceId = toFiniteNumber(watchedInstanceId);
  const numericEndpointId = toFiniteNumber(watchedEndpointId);
  const numericStackId = toFiniteNumber(watchedStackId);

  const [endpoints, setEndpoints] = useState<PortainerEndpointSummary[]>([]);
  const [stacks, setStacks] = useState<PortainerStackSummary[]>([]);
  const [loadingEndpoints, setLoadingEndpoints] = useState(false);
  const [loadingStacks, setLoadingStacks] = useState(false);

  const fetchEndpoints = useCallback(async () => {
    if (instanceIsVar) {
      setEndpoints([]);
      return;
    }
    setLoadingEndpoints(true);
    try {
      const res = await api.request<{ data?: PortainerEndpointSummary[] }>({
        url: `${PORTAINER_RESOURCE}:listEndpoints`,
        method: 'get',
        params: numericInstanceId ? { instanceId: numericInstanceId } : {},
      });
      setEndpoints(Array.isArray(res?.data?.data) ? res.data.data : []);
    } catch {
      setEndpoints([]);
    } finally {
      setLoadingEndpoints(false);
    }
  }, [api, instanceIsVar, numericInstanceId]);

  const fetchStacks = useCallback(async () => {
    if (instanceIsVar || endpointIsVar) {
      setStacks([]);
      return;
    }
    setLoadingStacks(true);
    try {
      const res = await api.request<{ data?: PortainerStackSummary[] }>({
        url: `${PORTAINER_RESOURCE}:listStacks`,
        method: 'get',
        params: {
          ...(numericInstanceId ? { instanceId: numericInstanceId } : {}),
          ...(numericEndpointId ? { endpointId: numericEndpointId } : {}),
        },
      });
      setStacks(Array.isArray(res?.data?.data) ? res.data.data : []);
    } catch {
      setStacks([]);
    } finally {
      setLoadingStacks(false);
    }
  }, [api, endpointIsVar, instanceIsVar, numericEndpointId, numericInstanceId]);

  useEffect(() => {
    fetchEndpoints();
  }, [fetchEndpoints]);

  useEffect(() => {
    fetchStacks();
  }, [fetchStacks]);

  const selectedStack = useMemo(
    () => (numericStackId ? stacks.find((item) => item.id === numericStackId) : undefined),
    [numericStackId, stacks],
  );

  useEffect(() => {
    onStackContextChange?.({
      instanceId: instanceIsVar ? undefined : numericInstanceId,
      stack: stackIsVar ? undefined : selectedStack,
    });
  }, [instanceIsVar, numericInstanceId, onStackContextChange, selectedStack, stackIsVar]);

  const endpointOptions = useMemo(
    () =>
      endpoints.map((ep) => ({
        value: ep.id,
        searchLabel: `${ep.name} ${ep.id}`,
        label: (
          <Flex align="center" justify="space-between" gap="small">
            <span>
              {ep.name} (#{ep.id})
            </span>
            <Tag color={ep.status === 1 ? 'success' : 'default'} style={{ marginInlineEnd: 0 }}>
              {ep.status === 1 ? t('Up') : t('Down')}
            </Tag>
          </Flex>
        ),
      })),
    [endpoints, t],
  );

  const stackOptions = useMemo(
    () =>
      stacks.map((st) => ({
        value: st.id,
        searchLabel: `${st.name} ${st.id} ${st.gitReference ?? ''}`,
        label: (
          <Flex align="center" justify="space-between" gap="small">
            <span>
              {st.name} (#{st.id})
            </span>
            <span>
              <Tag color={st.isGitStack ? 'processing' : 'purple'}>{st.isGitStack ? t('Git Stack') : t('Compose')}</Tag>
              {st.gitReference ? (
                <Tag style={{ marginInlineEnd: 0 }}>{st.gitReference.replace(/^refs\/heads\//, '')}</Tag>
              ) : null}
            </span>
          </Flex>
        ),
      })),
    [stacks, t],
  );

  return (
    <>
      <PortainerInstanceField />

      <Form.Item
        name={['config', 'endpointId']}
        label={t('Environment (Endpoint)')}
        extra={t('Select a Portainer environment or bind a dynamic endpointId variable.')}
      >
        <WorkflowVariableWrapper<number>
          render={({ value, onChange }) =>
            instanceIsVar ? (
              <InputNumber
                min={1}
                value={toFiniteNumber(value)}
                onChange={(nextVal) => onChange?.(typeof nextVal === 'number' ? nextVal : null)}
                placeholder={t('Endpoint ID (e.g. 1)')}
                style={{ width: '100%' }}
              />
            ) : (
              <Flex gap="small" style={{ width: '100%' }}>
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="searchLabel"
                  loading={loadingEndpoints}
                  value={toFiniteNumber(value)}
                  onChange={(nextVal) => onChange?.(typeof nextVal === 'number' ? nextVal : null)}
                  options={endpointOptions}
                  placeholder={t('Auto-resolve from Stack or select environment')}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <Button
                  htmlType="button"
                  aria-label={t('Refresh Portainer environments')}
                  icon={<ReloadOutlined />}
                  loading={loadingEndpoints}
                  onClick={() => {
                    fetchEndpoints();
                    fetchStacks();
                  }}
                />
              </Flex>
            )
          }
        />
      </Form.Item>

      <Form.Item
        name={['config', 'stackId']}
        label={t('Target Stack')}
        rules={[{ required: true, message: t('Please select a Stack or bind a Stack ID variable') }]}
        extra={
          selectedStack?.isGitStack
            ? `${t('Connected Git repository')}: ${selectedStack.gitRepoUrl ?? '-'} (${
                selectedStack.gitReference ?? 'refs/heads/main'
              })`
            : t('Choose the Portainer Stack to control or bind a stackId variable from upstream data.')
        }
      >
        <WorkflowVariableWrapper<number>
          render={({ value, onChange }) =>
            instanceIsVar || endpointIsVar ? (
              <InputNumber
                min={1}
                value={toFiniteNumber(value)}
                onChange={(nextVal) => onChange?.(typeof nextVal === 'number' ? nextVal : null)}
                placeholder={t('Stack ID (e.g. 12)')}
                style={{ width: '100%' }}
              />
            ) : (
              <Select
                allowClear
                showSearch
                optionFilterProp="searchLabel"
                loading={loadingStacks}
                value={toFiniteNumber(value)}
                onChange={(nextVal) => {
                  const numVal = typeof nextVal === 'number' ? nextVal : null;
                  onChange?.(numVal);
                  if (numVal && !numericEndpointId) {
                    const matched = stacks.find((item) => item.id === numVal);
                    if (matched?.endpointId) {
                      form.setFieldValue(['config', 'endpointId'], matched.endpointId);
                    }
                  }
                }}
                options={stackOptions}
                placeholder={t('Select Portainer Stack')}
                style={{ width: '100%' }}
              />
            )
          }
        />
      </Form.Item>
    </>
  );
}
