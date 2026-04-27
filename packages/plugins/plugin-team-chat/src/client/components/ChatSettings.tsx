import React from 'react';
import { Card, Typography } from 'antd';

const ChatSettings: React.FC = () => (
  <Card title="Team Chat Settings" style={{ maxWidth: 600 }}>
    <Typography.Paragraph>
      Team Chat is active. Navigate to <a href="/chat">/chat</a> to start chatting.
    </Typography.Paragraph>
    <Typography.Paragraph type="secondary">
      Channels and messages are managed via the chat interface.
      Admin users can configure channel permissions via the ACL settings.
    </Typography.Paragraph>
  </Card>
);

export default ChatSettings;
