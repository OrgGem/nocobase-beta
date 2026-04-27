import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Input, Button, Avatar, Tooltip } from 'antd';
import { SendOutlined, SmileOutlined, PaperClipOutlined, PhoneOutlined, VideoCameraOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { useChatContext } from '../hooks/useChatContext';

export const MessagePanel: React.FC = () => {
  const { activeChannel, messages, sendMessage, typingUsers, currentUser, loadMoreMessages, hasMore } = useChatContext();
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<any>(null);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => { inputRef.current?.focus(); setInputValue(''); }, [activeChannel?.id]);

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text) return;
    await sendMessage(text);
    setInputValue('');
  }, [inputValue, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const formatTime = (d: string) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.2)' }}>
        <div>
          <div style={{ color: '#fff', fontSize: 16, fontWeight: 600 }}># {activeChannel?.name}</div>
          {activeChannel?.topic && <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>{activeChannel.topic}</div>}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <Tooltip title="Voice Call"><Button type="text" icon={<PhoneOutlined />} style={{ color: 'rgba(255,255,255,0.5)' }} /></Tooltip>
          <Tooltip title="Video Call"><Button type="text" icon={<VideoCameraOutlined />} style={{ color: 'rgba(255,255,255,0.5)' }} /></Tooltip>
          <Tooltip title="Channel Info"><Button type="text" icon={<InfoCircleOutlined />} style={{ color: 'rgba(255,255,255,0.5)' }} /></Tooltip>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
        {hasMore && <div style={{ textAlign: 'center', marginBottom: 16 }}><Button type="link" onClick={loadMoreMessages} style={{ color: 'rgba(255,255,255,0.4)' }}>Load earlier messages...</Button></div>}
        {messages.length === 0 && <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'rgba(255,255,255,0.3)' }}><div style={{ fontSize: 48 }}>🎉</div><div>No messages yet</div></div>}
        {messages.map((msg: any, idx: number) => {
          const showAvatar = idx === 0 || messages[idx - 1]?.senderId !== msg.senderId;
          const isOwn = msg.senderId === currentUser?.id;
          return (
            <div key={msg.id} style={{ display: 'flex', gap: 10, padding: showAvatar ? '8px 0' : '1px 0', marginLeft: showAvatar ? 0 : 42 }}>
              {showAvatar && <Avatar size={32} style={{ background: isOwn ? 'linear-gradient(135deg, #6366f1, #8b5cf6)' : 'linear-gradient(135deg, #10b981, #059669)', flexShrink: 0, fontSize: 13 }}>{msg.sender?.nickname?.[0] || '?'}</Avatar>}
              <div style={{ flex: 1 }}>
                {showAvatar && <div style={{ display: 'flex', gap: 8, marginBottom: 2 }}><span style={{ color: isOwn ? '#8b5cf6' : '#10b981', fontWeight: 600, fontSize: 13 }}>{msg.sender?.nickname || msg.sender?.username || 'Unknown'}</span><span style={{ color: 'rgba(255,255,255,0.2)', fontSize: 11 }}>{formatTime(msg.createdAt)}</span></div>}
                <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, lineHeight: 1.5, wordBreak: 'break-word' }}>{msg.isDeleted ? <i style={{ color: 'rgba(255,255,255,0.2)' }}>Message deleted</i> : msg.content}</div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Typing */}
      {typingUsers.length > 0 && <div style={{ padding: '4px 20px', fontSize: 12, color: 'rgba(255,255,255,0.4)', fontStyle: 'italic' }}>{typingUsers.join(', ')} typing...</div>}

      {/* Input */}
      <div style={{ padding: '12px 20px 16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', background: 'rgba(255,255,255,0.04)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)', padding: '8px 12px' }}>
          <Button type="text" icon={<PaperClipOutlined />} style={{ color: 'rgba(255,255,255,0.3)' }} />
          <Input.TextArea ref={inputRef} value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={handleKeyDown} placeholder={`Message #${activeChannel?.name || ''}...`} autoSize={{ minRows: 1, maxRows: 5 }} style={{ background: 'transparent', border: 'none', color: '#fff', resize: 'none', boxShadow: 'none' }} />
          <Button type="text" icon={<SmileOutlined />} style={{ color: 'rgba(255,255,255,0.3)' }} />
          <Button type="primary" icon={<SendOutlined />} onClick={handleSend} disabled={!inputValue.trim()} style={{ borderRadius: 8, background: inputValue.trim() ? 'linear-gradient(135deg, #6366f1, #8b5cf6)' : 'rgba(255,255,255,0.06)', border: 'none' }} />
        </div>
      </div>
    </div>
  );
};
