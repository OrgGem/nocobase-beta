import React, { useState, useEffect, useCallback } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Table, Card, Tag, Button, Space, Select, Statistic, Row, Col, Modal, Badge, Tooltip, Typography, Divider } from 'antd';
import { VideoCameraOutlined, AudioOutlined, DesktopOutlined, StopOutlined, ReloadOutlined, TeamOutlined, ClockCircleOutlined, CalendarOutlined } from '@ant-design/icons';

const { Text, Title } = Typography;

interface MeetingStats {
  totalMeetings: number;
  activeMeetings: number;
  todayMeetings: number;
  totalDurationMinutes: number;
  endedMeetings: number;
}

/**
 * MeetingAdmin — Admin-only dashboard for managing all meetings.
 * Accessible via Plugin Settings > Communication Suite > Meeting Management.
 */
const MeetingAdmin: React.FC = () => {
  const api = useAPIClient();
  const [meetings, setMeetings] = useState<any[]>([]);
  const [stats, setStats] = useState<MeetingStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string | undefined>();

  const fetchStats = useCallback(async () => {
    try {
      const { data } = await api.request({ url: 'commMeetings:adminStats', method: 'post' });
      setStats(data?.data || null);
    } catch (err) {
      console.error('[meeting-admin] Stats fetch failed:', err);
    }
  }, [api]);

  const fetchMeetings = useCallback(async () => {
    setLoading(true);
    try {
      const params: any = { page, pageSize: 15 };
      if (statusFilter) params.status = statusFilter;
      const { data } = await api.request({ url: 'commMeetings:adminList', method: 'post', params });
      const result = data?.data || {};
      setMeetings(result.data || []);
      setTotal(result.meta?.total || 0);
    } catch (err) {
      console.error('[meeting-admin] List fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, [api, page, statusFilter]);

  useEffect(() => { fetchStats(); }, [fetchStats]);
  useEffect(() => { fetchMeetings(); }, [fetchMeetings]);

  const handleForceEnd = useCallback(async (meetingId: string) => {
    Modal.confirm({
      title: 'Force End Meeting',
      content: 'This will immediately disconnect all participants. Continue?',
      okText: 'End Now',
      okType: 'danger',
      onOk: async () => {
        await api.request({ url: 'commMeetings:adminForceEnd', method: 'post', params: { filterByTk: meetingId } });
        fetchMeetings();
        fetchStats();
      },
    });
  }, [api, fetchMeetings, fetchStats]);

  const formatDuration = (seconds: number) => {
    if (!seconds) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'video': return <VideoCameraOutlined style={{ color: '#6366f1' }} />;
      case 'audio': return <AudioOutlined style={{ color: '#10b981' }} />;
      case 'screen_share': return <DesktopOutlined style={{ color: '#f59e0b' }} />;
      default: return <VideoCameraOutlined />;
    }
  };

  const getStatusTag = (status: string) => {
    const map: Record<string, { color: string; label: string }> = {
      active: { color: '#52c41a', label: '● LIVE' },
      scheduled: { color: '#6366f1', label: 'Scheduled' },
      ringing: { color: '#f59e0b', label: 'Ringing' },
      ended: { color: '#666', label: 'Ended' },
      missed: { color: '#ff4d4f', label: 'Missed' },
      declined: { color: '#ff7875', label: 'Declined' },
      cancelled: { color: '#999', label: 'Cancelled' },
    };
    const cfg = map[status] || { color: '#666', label: status };
    return <Tag color={cfg.color}>{cfg.label}</Tag>;
  };

  const columns = [
    {
      title: 'Type',
      dataIndex: 'type',
      width: 60,
      render: (type: string) => getTypeIcon(type),
    },
    {
      title: 'Title',
      dataIndex: 'title',
      render: (title: string, record: any) => (
        <div>
          <div style={{ fontWeight: 500 }}>{title || `Meeting #${record.id}`}</div>
          {record.channel && <Text type="secondary" style={{ fontSize: 12 }}>#{record.channel.name}</Text>}
        </div>
      ),
    },
    {
      title: 'Initiator',
      dataIndex: 'initiator',
      render: (user: any) => user?.nickname || user?.username || '—',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      render: getStatusTag,
    },
    {
      title: 'Participants',
      dataIndex: 'participants',
      render: (participants: any[]) => (
        <Badge count={participants?.length || 0} style={{ backgroundColor: '#6366f1' }} showZero>
          <TeamOutlined style={{ fontSize: 16, color: '#999' }} />
        </Badge>
      ),
    },
    {
      title: 'Scheduled',
      dataIndex: 'scheduledAt',
      render: (d: string) => d ? new Date(d).toLocaleString() : '—',
    },
    {
      title: 'Duration',
      dataIndex: 'duration',
      render: formatDuration,
    },
    {
      title: 'Actions',
      render: (_: any, record: any) => (
        <Space>
          {record.status === 'active' && (
            <Tooltip title="Force End">
              <Button danger size="small" icon={<StopOutlined />} onClick={() => handleForceEnd(record.id)}>
                End
              </Button>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 4 }}>
      <Title level={4} style={{ marginBottom: 16 }}>
        <VideoCameraOutlined style={{ marginRight: 8 }} />
        Meeting Management
      </Title>

      {/* Stats Cards */}
      {stats && (
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col span={6}>
            <Card size="small" bordered>
              <Statistic
                title="Active Now"
                value={stats.activeMeetings}
                prefix={<Badge status={stats.activeMeetings > 0 ? 'processing' : 'default'} />}
                valueStyle={{ color: stats.activeMeetings > 0 ? '#52c41a' : '#999' }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small" bordered>
              <Statistic title="Today" value={stats.todayMeetings} prefix={<CalendarOutlined />} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small" bordered>
              <Statistic title="Total Meetings" value={stats.totalMeetings} prefix={<TeamOutlined />} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small" bordered>
              <Statistic
                title="Total Duration"
                value={stats.totalDurationMinutes}
                suffix="min"
                prefix={<ClockCircleOutlined />}
              />
            </Card>
          </Col>
        </Row>
      )}

      {/* Filters & Table */}
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <Space>
            <Select
              placeholder="Filter by status"
              allowClear
              style={{ width: 160 }}
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'active', label: '● Active' },
                { value: 'scheduled', label: 'Scheduled' },
                { value: 'ringing', label: 'Ringing' },
                { value: 'ended', label: 'Ended' },
                { value: 'missed', label: 'Missed' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
            />
          </Space>
          <Button icon={<ReloadOutlined />} onClick={() => { fetchMeetings(); fetchStats(); }}>
            Refresh
          </Button>
        </div>

        <Table
          columns={columns}
          dataSource={meetings}
          loading={loading}
          rowKey="id"
          size="small"
          pagination={{
            current: page,
            total,
            pageSize: 15,
            onChange: setPage,
            showTotal: (t: number) => `${t} meetings`,
          }}
        />
      </Card>
    </div>
  );
};

export default MeetingAdmin;
