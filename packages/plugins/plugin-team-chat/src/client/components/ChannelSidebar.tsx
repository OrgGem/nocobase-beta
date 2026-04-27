import React, { useState, useMemo } from 'react';
import { Input, Button, Modal, Form, Select, Badge, Tooltip } from 'antd';
import {
  PlusOutlined,
  SearchOutlined,
  TeamOutlined,
  UserOutlined,
  PushpinOutlined,
  MessageOutlined,
} from '@ant-design/icons';
import { useChatContext } from '../hooks/useChatContext';

const { Option } = Select;

/**
 * ChannelSidebar — displays user's channels, DMs, and search.
 */
export const ChannelSidebar: React.FC = () => {
  const { channels, activeChannel, setActiveChannel, unreadCounts, createChannel } = useChatContext();
  const [searchText, setSearchText] = useState('');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [form] = Form.useForm();

  // Separate pinned, channels, and DMs
  const { pinned, publicChannels, directMessages } = useMemo(() => {
    const filtered = channels.filter((ch: any) =>
      ch.name?.toLowerCase().includes(searchText.toLowerCase())
    );
    return {
      pinned: filtered.filter((ch: any) => ch.membership?.isPinned),
      publicChannels: filtered.filter((ch: any) => ch.type === 'public' || ch.type === 'group'),
      directMessages: filtered.filter((ch: any) => ch.type === 'direct'),
    };
  }, [channels, searchText]);

  const handleCreateChannel = async () => {
    const values = await form.validateFields();
    await createChannel(values);
    form.resetFields();
    setIsCreateModalOpen(false);
  };

  const renderChannelItem = (channel: any) => {
    const isActive = activeChannel?.id === channel.id;
    const unread = unreadCounts[channel.id] || 0;

    return (
      <div
        key={channel.id}
        onClick={() => setActiveChannel(channel)}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '8px 16px',
          cursor: 'pointer',
          borderRadius: 8,
          margin: '2px 8px',
          background: isActive
            ? 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.15))'
            : 'transparent',
          borderLeft: isActive ? '3px solid #6366f1' : '3px solid transparent',
          transition: 'all 0.15s ease',
        }}
        onMouseEnter={(e) => {
          if (!isActive) {
            (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isActive) {
            (e.currentTarget as HTMLElement).style.background = 'transparent';
          }
        }}
      >
        <div style={{
          width: 32,
          height: 32,
          borderRadius: channel.type === 'direct' ? '50%' : 8,
          background: channel.type === 'direct'
            ? 'linear-gradient(135deg, #6366f1, #8b5cf6)'
            : 'linear-gradient(135deg, #10b981, #059669)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: 10,
          fontSize: 14,
          color: '#fff',
          flexShrink: 0,
        }}>
          {channel.type === 'direct' ? <UserOutlined /> : '#'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            color: unread > 0 ? '#fff' : 'rgba(255,255,255,0.7)',
            fontWeight: unread > 0 ? 600 : 400,
            fontSize: 13,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {channel.name}
          </div>
        </div>
        {unread > 0 && (
          <Badge
            count={unread}
            style={{
              backgroundColor: '#6366f1',
              boxShadow: '0 0 6px rgba(99,102,241,0.5)',
              fontSize: 10,
            }}
          />
        )}
      </div>
    );
  };

  const sectionHeader = (title: string, icon: React.ReactNode, count?: number) => (
    <div style={{
      padding: '16px 16px 6px',
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      color: 'rgba(255,255,255,0.35)',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    }}>
      {icon}
      {title}
      {count !== undefined && (
        <span style={{ color: 'rgba(255,255,255,0.2)', fontWeight: 400 }}>({count})</span>
      )}
    </div>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{
        padding: '16px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}>
          <span style={{
            fontSize: 18,
            fontWeight: 700,
            color: '#fff',
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>
            💬 Chat
          </span>
          <Tooltip title="New Channel">
            <Button
              type="text"
              icon={<PlusOutlined />}
              onClick={() => setIsCreateModalOpen(true)}
              style={{
                color: 'rgba(255,255,255,0.5)',
                borderRadius: 8,
              }}
            />
          </Tooltip>
        </div>
        <Input
          prefix={<SearchOutlined style={{ color: 'rgba(255,255,255,0.2)' }} />}
          placeholder="Search channels..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            color: '#fff',
          }}
        />
      </div>

      {/* Channel List */}
      <div style={{ flex: 1, overflow: 'auto', paddingBottom: 16 }}>
        {pinned.length > 0 && (
          <>
            {sectionHeader('Pinned', <PushpinOutlined />, pinned.length)}
            {pinned.map(renderChannelItem)}
          </>
        )}

        {sectionHeader('Channels', <TeamOutlined />, publicChannels.length)}
        {publicChannels.map(renderChannelItem)}

        {directMessages.length > 0 && (
          <>
            {sectionHeader('Direct Messages', <MessageOutlined />, directMessages.length)}
            {directMessages.map(renderChannelItem)}
          </>
        )}
      </div>

      {/* Create Channel Modal */}
      <Modal
        title="Create Channel"
        open={isCreateModalOpen}
        onOk={handleCreateChannel}
        onCancel={() => setIsCreateModalOpen(false)}
        okText="Create"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Channel Name" rules={[{ required: true }]}>
            <Input placeholder="e.g., project-alpha" />
          </Form.Item>
          <Form.Item name="type" label="Type" initialValue="public">
            <Select>
              <Option value="public">Public Channel</Option>
              <Option value="group">Private Group</Option>
            </Select>
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="What's this channel about?" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
