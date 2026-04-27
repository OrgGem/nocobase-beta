import React, { useState } from 'react';
import { useApp, useAPIClient } from '@nocobase/client';
import { Layout, Spin } from 'antd';
import { MessageOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { ChannelSidebar } from './ChannelSidebar';
import { MessagePanel } from './MessagePanel';
import { MeetingManager } from './MeetingManager';
import { ChatProvider, useChatContext } from '../hooks/useChatContext';

const { Sider, Content } = Layout;

type ActiveView = 'chat' | 'meetings';

/**
 * ChatPage — Main chat interface with channel sidebar, message panel, and meeting manager.
 * Users can switch between Chat and Meetings via the sidebar navigation.
 */
const ChatPageInner: React.FC = () => {
  const { activeChannel, loading } = useChatContext();
  const [activeView, setActiveView] = useState<ActiveView>('chat');

  if (loading) {
    return (
      <div style={{
        display: 'flex', justifyContent: 'center', alignItems: 'center',
        height: '100vh', background: '#0a0a0f',
      }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <Layout style={{ height: '100vh', background: '#0a0a0f' }}>
      {/* Navigation Rail + Channel Sidebar */}
      <div style={{ display: 'flex', height: '100%' }}>
        {/* Navigation Rail — switch between Chat and Meetings */}
        <div style={{
          width: 56,
          background: 'linear-gradient(180deg, #08080f 0%, #0a0a14 100%)',
          borderRight: '1px solid rgba(255,255,255,0.04)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: 16,
          gap: 4,
        }}>
          <NavButton
            icon={<MessageOutlined />}
            label="Chat"
            active={activeView === 'chat'}
            onClick={() => setActiveView('chat')}
          />
          <NavButton
            icon={<VideoCameraOutlined />}
            label="Meetings"
            active={activeView === 'meetings'}
            onClick={() => setActiveView('meetings')}
          />
        </div>

        {/* Sidebar — only visible in chat view */}
        {activeView === 'chat' && (
          <Sider
            width={260}
            style={{
              background: 'linear-gradient(180deg, #0d0d14 0%, #111122 100%)',
              borderRight: '1px solid rgba(255,255,255,0.06)',
              overflow: 'auto',
            }}
          >
            <ChannelSidebar />
          </Sider>
        )}
      </div>

      {/* Main Content Area */}
      <Content style={{ background: '#0f0f1a' }}>
        {activeView === 'meetings' ? (
          <MeetingManager />
        ) : activeChannel ? (
          <MessagePanel />
        ) : (
          <div style={{
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
            alignItems: 'center', height: '100%', color: 'rgba(255,255,255,0.3)', gap: 16,
          }}>
            <div style={{ fontSize: 64 }}>💬</div>
            <div style={{ fontSize: 20, fontWeight: 500 }}>Select a channel to start chatting</div>
            <div style={{ fontSize: 14 }}>or create a new channel from the sidebar</div>
          </div>
        )}
      </Content>
    </Layout>
  );
};

/**
 * NavButton — a compact icon button for the left navigation rail.
 */
const NavButton: React.FC<{
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}> = ({ icon, label, active, onClick }) => (
  <div
    onClick={onClick}
    title={label}
    style={{
      width: 40,
      height: 40,
      borderRadius: 10,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
      background: active
        ? 'linear-gradient(135deg, rgba(99,102,241,0.25), rgba(139,92,246,0.2))'
        : 'transparent',
      color: active ? '#8b5cf6' : 'rgba(255,255,255,0.35)',
      fontSize: 18,
      transition: 'all 0.2s ease',
      position: 'relative',
    }}
  >
    {active && (
      <div style={{
        position: 'absolute',
        left: -8,
        width: 3,
        height: 20,
        borderRadius: 2,
        background: 'linear-gradient(180deg, #6366f1, #8b5cf6)',
      }} />
    )}
    {icon}
    <span style={{ fontSize: 9, marginTop: 2, fontWeight: active ? 600 : 400 }}>{label}</span>
  </div>
);

const ChatPage: React.FC = () => {
  return (
    <ChatProvider>
      <ChatPageInner />
    </ChatProvider>
  );
};

export default ChatPage;
