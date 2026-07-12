/**
 * Robot & Session Panel — robots list + sessions table
 */

import React, { useState } from 'react';
import { Alert, Table, Tag, Card, Space, Input, Select, Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { toUiPathArray, useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';
import { combineFilters, containsFilter, equalsFilter } from '../utils/odataFilters';

const SESSION_STATES = ['Available', 'Busy', 'Disconnected', 'Unresponsive'];

export const RobotSessionPanel: React.FC = () => {
  const t = useT();
  const [robotSearch, setRobotSearch] = useState('');
  const [machineSearch, setMachineSearch] = useState('');
  const [sessionState, setSessionState] = useState<string | undefined>();
  const robotFilter = combineFilters([
    containsFilter('Name', robotSearch),
    containsFilter('MachineName', machineSearch),
  ]);
  const sessionFilter = combineFilters([
    containsFilter('RobotName', robotSearch),
    containsFilter('HostMachineName', machineSearch),
    equalsFilter('State', sessionState),
  ]);
  const {
    data: robots,
    loading: rLoading,
    error: robotsError,
    refresh: refreshRobots,
  } = useUiPathRequest('uipathRobots', 'list', {
    filter: robotFilter,
    top: 100,
  });
  const {
    data: sessions,
    loading: sLoading,
    error: sessionsError,
    refresh: refreshSessions,
  } = useUiPathRequest('uipathSessions', 'list', {
    filter: sessionFilter,
    top: 100,
  });
  const robotRows = toUiPathArray(robots);
  const sessionRows = toUiPathArray(sessions);

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search placeholder={t('Robot')} style={{ width: 220 }} onSearch={setRobotSearch} allowClear />
        <Input.Search placeholder={t('Machine')} style={{ width: 220 }} onSearch={setMachineSearch} allowClear />
        <Select
          placeholder={t('Session state')}
          allowClear
          style={{ width: 180 }}
          value={sessionState}
          onChange={setSessionState}
          options={SESSION_STATES.map((value) => ({ label: value, value }))}
        />
        <Button
          icon={<ReloadOutlined />}
          onClick={() => {
            refreshRobots();
            refreshSessions();
          }}
        >
          {t('Refresh')}
        </Button>
      </Space>
      <Card title={t('Robots')} size="small" style={{ marginBottom: 16 }}>
        {robotsError ? (
          <Alert
            type="error"
            showIcon
            message={t('Failed')}
            description={robotsError.message}
            style={{ marginBottom: 16 }}
          />
        ) : null}
        <Table
          dataSource={robotRows}
          rowKey="Id"
          loading={rLoading}
          size="small"
          pagination={{ pageSize: 50 }}
          columns={[
            { title: t('Name'), dataIndex: 'Name', ellipsis: true },
            { title: t('Machine'), dataIndex: 'MachineName', ellipsis: true },
            { title: t('Type'), dataIndex: 'Type', width: 120 },
            { title: t('Username'), dataIndex: 'Username', ellipsis: true },
          ]}
        />
      </Card>
      <Card title={t('Sessions')} size="small">
        {sessionsError ? (
          <Alert
            type="error"
            showIcon
            message={t('Failed')}
            description={sessionsError.message}
            style={{ marginBottom: 16 }}
          />
        ) : null}
        <Table
          dataSource={sessionRows}
          rowKey="Id"
          loading={sLoading}
          size="small"
          pagination={{ pageSize: 50 }}
          columns={[
            { title: t('Robot'), dataIndex: 'RobotName', ellipsis: true },
            { title: t('Machine'), dataIndex: 'HostMachineName', ellipsis: true },
            {
              title: t('State'),
              dataIndex: 'State',
              width: 120,
              render: (s: string) => <Tag color={s === 'Available' ? 'green' : s === 'Busy' ? 'blue' : 'red'}>{s}</Tag>,
            },
            {
              title: t('Reporting Time'),
              dataIndex: 'ReportingTime',
              width: 180,
              render: (v: string) => (v ? new Date(v).toLocaleString() : '-'),
            },
          ]}
        />
      </Card>
    </div>
  );
};
