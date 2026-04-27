import React, { useState, useEffect, useCallback } from 'react';
import { useAPIClient, useCurrentUserContext } from '@nocobase/client';
import { Button, Card, Empty, List, Tag, Space, Modal, Form, Input, Select, DatePicker, Switch, Avatar, Tooltip, Tabs, Badge, Divider } from 'antd';
import { VideoCameraOutlined, AudioOutlined, PlusOutlined, CalendarOutlined, ClockCircleOutlined, PlayCircleOutlined, CloseCircleOutlined, TeamOutlined, HistoryOutlined } from '@ant-design/icons';
import { VideoCallRoom } from './VideoCallRoom';

const { RangePicker } = DatePicker;

/**
 * MeetingManager — User-facing meeting panel inside /chat.
 * Allows users to schedule, view, and manage their own meetings.
 */
export const MeetingManager: React.FC = () => {
  const api = useAPIClient();
  const userCtx = useCurrentUserContext();
  const currentUser = userCtx?.data?.data;

  const [meetings, setMeetings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('upcoming');
  const [isScheduleOpen, setIsScheduleOpen] = useState(false);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [form] = Form.useForm();

  const fetchMeetings = useCallback(async () => {
    setLoading(true);
    try {
      const params: any = {};
      if (activeTab === 'upcoming') params.upcoming = 'true';
      if (activeTab === 'active') params.status = 'active';
      if (activeTab === 'history') params.status = 'ended';

      const { data } = await api.request({ url: 'commMeetings:myMeetings', method: 'post', params });
      setMeetings(data?.data || []);
    } catch (err) {
      console.error('[meeting-manager] Fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, [api, activeTab]);

  useEffect(() => { fetchMeetings(); }, [fetchMeetings]);

  const handleSchedule = useCallback(async () => {
    try {
      const values = await form.validateFields();
      const payload: any = {
        title: values.title,
        type: values.type || 'video',
        scheduledAt: values.timeRange?.[0]?.toISOString(),
        scheduledEndAt: values.timeRange?.[1]?.toISOString(),
        isRecurring: values.isRecurring || false,
        recurrenceRule: values.recurrenceRule || null,
        metadata: { description: values.description || '' },
      };

      await api.request({ url: 'commMeetings:schedule', method: 'post', data: { values: payload } });
      form.resetFields();
      setIsScheduleOpen(false);
      fetchMeetings();
    } catch (err) {
      console.error('[meeting-manager] Schedule failed:', err);
    }
  }, [api, form, fetchMeetings]);

  const handleCancel = useCallback(async (meetingId: string) => {
    Modal.confirm({
      title: 'Cancel Meeting',
      content: 'All invited participants will be notified. Cancel this meeting?',
      onOk: async () => {
        await api.request({ url: 'commMeetings:cancel', method: 'post', params: { filterByTk: meetingId } });
        fetchMeetings();
      },
    });
  }, [api, fetchMeetings]);

  const handleStart = useCallback(async (meetingId: string) => {
    await api.request({ url: 'commMeetings:start', method: 'post', params: { filterByTk: meetingId } });
    // Immediately enter the video call
    setActiveCallId(meetingId);
  }, [api]);

  const handleJoinCall = useCallback((meetingId: string) => {
    setActiveCallId(meetingId);
  }, []);

  const handleLeaveCall = useCallback(() => {
    setActiveCallId(null);
    fetchMeetings();
  }, [fetchMeetings]);

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'video': return <VideoCameraOutlined style={{ color: '#6366f1' }} />;
      case 'audio': return <AudioOutlined style={{ color: '#10b981' }} />;
      default: return <VideoCameraOutlined style={{ color: '#6366f1' }} />;
    }
  };

  const getStatusTag = (status: string) => {
    const map: Record<string, { color: string; text: string }> = {
      scheduled: { color: 'blue', text: 'Scheduled' },
      active: { color: 'green', text: '● LIVE' },
      ended: { color: 'default', text: 'Ended' },
      cancelled: { color: 'default', text: 'Cancelled' },
      missed: { color: 'red', text: 'Missed' },
      ringing: { color: 'orange', text: 'Ringing' },
    };
    const c = map[status] || { color: 'default', text: status };
    return <Tag color={c.color}>{c.text}</Tag>;
  };

  const formatTime = (d: string) => d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

  const formatDuration = (sec: number) => {
    if (!sec) return '';
    const m = Math.floor(sec / 60);
    return m > 0 ? `${m} min` : `${sec}s`;
  };

  const renderMeetingItem = (meeting: any) => {
    const data = meeting.toJSON ? meeting.toJSON() : meeting;
    const isHost = data.initiatorId === currentUser?.id;
    const participantCount = data.participants?.length || 0;

    return (
      <div
        key={data.id}
        style={{
          padding: '14px 16px',
          borderRadius: 10,
          background: data.status === 'active'
            ? 'linear-gradient(135deg, rgba(82,196,26,0.08), rgba(82,196,26,0.03))'
            : 'rgba(255,255,255,0.02)',
          border: data.status === 'active'
            ? '1px solid rgba(82,196,26,0.2)'
            : '1px solid rgba(255,255,255,0.06)',
          marginBottom: 8,
          transition: 'all 0.15s ease',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: 12, flex: 1 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: data.status === 'active'
                ? 'linear-gradient(135deg, #52c41a, #389e0d)'
                : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18, flexShrink: 0,
            }}>
              {getTypeIcon(data.type)}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#fff', fontWeight: 600, fontSize: 14 }}>
                  {data.title || `Meeting #${data.id}`}
                </span>
                {getStatusTag(data.status)}
                {isHost && <Tag style={{ fontSize: 10 }}>Host</Tag>}
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 4, color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>
                <span><CalendarOutlined style={{ marginRight: 4 }} />{formatTime(data.scheduledAt || data.createdAt)}</span>
                {participantCount > 0 && <span><TeamOutlined style={{ marginRight: 4 }} />{participantCount} participants</span>}
                {data.duration > 0 && <span><ClockCircleOutlined style={{ marginRight: 4 }} />{formatDuration(data.duration)}</span>}
                {data.channel && <span style={{ color: 'rgba(139,92,246,0.6)' }}>#{data.channel.name}</span>}
              </div>
              {/* Participant avatars */}
              {data.participants?.length > 0 && (
                <div style={{ display: 'flex', gap: 2, marginTop: 6 }}>
                  {data.participants.slice(0, 5).map((p: any, i: number) => {
                    const u = p.user || p;
                    return (
                      <Tooltip key={i} title={u.nickname || u.username}>
                        <Avatar size={22} style={{
                          background: p.role === 'host' ? '#6366f1' : '#1a1a2e',
                          border: '1px solid rgba(255,255,255,0.1)',
                          fontSize: 10,
                        }}>
                          {(u.nickname || u.username || '?')[0]}
                        </Avatar>
                      </Tooltip>
                    );
                  })}
                  {data.participants.length > 5 && (
                    <Avatar size={22} style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', fontSize: 10 }}>
                      +{data.participants.length - 5}
                    </Avatar>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <Space>
            {isHost && data.status === 'scheduled' && (
              <>
                <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => handleStart(data.id)}
                  style={{ background: 'linear-gradient(135deg, #52c41a, #389e0d)', border: 'none', borderRadius: 6 }}>
                  Start
                </Button>
                <Button size="small" danger icon={<CloseCircleOutlined />} onClick={() => handleCancel(data.id)}
                  style={{ borderRadius: 6 }}>
                  Cancel
                </Button>
              </>
            )}
            {data.status === 'active' && (
              <Button size="small" type="primary" icon={<VideoCameraOutlined />}
                onClick={() => handleJoinCall(data.id)}
                style={{ background: 'linear-gradient(135deg, #52c41a, #389e0d)', border: 'none', borderRadius: 6 }}>
                Join
              </Button>
            )}
          </Space>
        </div>
      </div>
    );
  };

  const tabItems = [
    {
      key: 'upcoming',
      label: <span><CalendarOutlined style={{ marginRight: 4 }} />Upcoming</span>,
    },
    {
      key: 'active',
      label: <span><Badge dot={meetings.some((m: any) => m.status === 'active')} offset={[6, 0]}><PlayCircleOutlined style={{ marginRight: 4 }} />Active</Badge></span>,
    },
    {
      key: 'history',
      label: <span><HistoryOutlined style={{ marginRight: 4 }} />History</span>,
    },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{
        padding: '16px 20px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: 'rgba(0,0,0,0.2)',
      }}>
        <div style={{ color: '#fff', fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          <VideoCameraOutlined style={{ color: '#6366f1' }} /> My Meetings
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setIsScheduleOpen(true)}
          style={{
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            border: 'none', borderRadius: 8,
            boxShadow: '0 2px 8px rgba(99,102,241,0.3)',
          }}
        >
          Schedule Meeting
        </Button>
      </div>

      {/* Tabs */}
      <div style={{ padding: '0 20px' }}>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems}
          style={{ color: 'rgba(255,255,255,0.7)' }} />
      </div>

      {/* Meeting List */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 20px 20px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'rgba(255,255,255,0.3)' }}>Loading...</div>
        ) : meetings.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: '60%', color: 'rgba(255,255,255,0.25)', gap: 12,
          }}>
            <div style={{ fontSize: 48 }}>📅</div>
            <div style={{ fontSize: 16 }}>
              {activeTab === 'upcoming' ? 'No upcoming meetings' : activeTab === 'active' ? 'No active calls' : 'No meeting history'}
            </div>
            {activeTab === 'upcoming' && (
              <Button type="link" onClick={() => setIsScheduleOpen(true)} style={{ color: '#6366f1' }}>
                Schedule your first meeting
              </Button>
            )}
          </div>
        ) : (
          meetings.map(renderMeetingItem)
        )}
      </div>

      {/* Schedule Meeting Modal */}
      <Modal
        title={<span><CalendarOutlined style={{ marginRight: 8 }} />Schedule Meeting</span>}
        open={isScheduleOpen}
        onOk={handleSchedule}
        onCancel={() => { setIsScheduleOpen(false); form.resetFields(); }}
        okText="Schedule"
        width={500}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="title" label="Meeting Title" rules={[{ required: true, message: 'Enter a title' }]}>
            <Input placeholder="e.g., Weekly Standup, Design Review" />
          </Form.Item>
          <Form.Item name="type" label="Type" initialValue="video">
            <Select options={[
              { value: 'video', label: '📹 Video Call' },
              { value: 'audio', label: '🎙️ Audio Call' },
            ]} />
          </Form.Item>
          <Form.Item name="timeRange" label="Date & Time" rules={[{ required: true, message: 'Select time' }]}>
            <RangePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} placeholder="Meeting agenda or notes..." />
          </Form.Item>
          <Form.Item name="isRecurring" label="Recurring" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, curr) => prev.isRecurring !== curr.isRecurring}>
            {({ getFieldValue }) =>
              getFieldValue('isRecurring') ? (
                <Form.Item name="recurrenceRule" label="Repeat">
                  <Select options={[
                    { value: 'FREQ=DAILY', label: 'Every day' },
                    { value: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', label: 'Every weekday' },
                    { value: 'FREQ=WEEKLY', label: 'Every week' },
                    { value: 'FREQ=MONTHLY', label: 'Every month' },
                  ]} />
                </Form.Item>
              ) : null
            }
          </Form.Item>
        </Form>
      </Modal>

      {/* Video Call Overlay */}
      {activeCallId && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: '#0a0a12',
        }}>
          <VideoCallRoom meetingId={activeCallId} onLeave={handleLeaveCall} />
        </div>
      )}
    </div>
  );
};

export default MeetingManager;
