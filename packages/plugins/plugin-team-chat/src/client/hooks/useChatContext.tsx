import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useApp, useAPIClient, useCurrentUserContext } from '@nocobase/client';

interface ChatContextType {
  channels: any[];
  activeChannel: any | null;
  setActiveChannel: (ch: any) => void;
  messages: any[];
  sendMessage: (content: string) => Promise<void>;
  createChannel: (values: any) => Promise<void>;
  unreadCounts: Record<string, number>;
  typingUsers: string[];
  currentUser: any;
  loading: boolean;
  loadMoreMessages: () => void;
  hasMore: boolean;
}

const ChatContext = createContext<ChatContextType>({} as ChatContextType);

export const useChatContext = () => useContext(ChatContext);

/**
 * ChatProvider — manages chat state, WS subscriptions, and API calls.
 */
export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const app = useApp();
  const api = useAPIClient();
  const userCtx = useCurrentUserContext();
  const currentUser = userCtx?.data?.data;

  const [channels, setChannels] = useState<any[]>([]);
  const [activeChannel, setActiveChannel] = useState<any | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const typingTimeouts = useRef<Record<string, NodeJS.Timeout>>({});

  // Fetch user's channels on mount
  useEffect(() => {
    const fetchChannels = async () => {
      try {
        const { data } = await api.request({ url: 'commChannels:myChannels', method: 'post' });
        const channelList = data?.data || [];
        setChannels(channelList);

        // Join all channels via WS
        if (app.ws && channelList.length > 0) {
          app.ws.send(JSON.stringify({
            type: 'comm',
            payload: {
              action: 'join_channels',
              data: { channelIds: channelList.map((c: any) => c.id) },
            },
          }));
        }
      } catch (err) {
        console.error('[team-chat] Failed to fetch channels:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchChannels();
  }, [api, app.ws]);

  // Fetch unread counts
  useEffect(() => {
    const fetchUnread = async () => {
      try {
        const { data } = await api.request({ url: 'commChannels:unreadCounts', method: 'post' });
        setUnreadCounts(data?.data || {});
      } catch (err) {
        console.error('[team-chat] Failed to fetch unread counts:', err);
      }
    };
    fetchUnread();
    const interval = setInterval(fetchUnread, 30000);
    return () => clearInterval(interval);
  }, [api]);

  // Fetch messages when active channel changes
  useEffect(() => {
    if (!activeChannel?.id) {
      setMessages([]);
      return;
    }

    const fetchMessages = async () => {
      try {
        const { data } = await api.request({
          url: 'commMessages:listByChannel',
          method: 'post',
          params: { channelId: activeChannel.id, limit: 50 },
        });
        const msgList = data?.data || [];
        setMessages(msgList);
        setHasMore(msgList.length >= 50);

        // Mark as read
        if (msgList.length > 0) {
          api.request({
            url: 'commMessages:markRead',
            method: 'post',
            params: { filterByTk: activeChannel.id },
            data: { messageId: msgList[msgList.length - 1]?.id },
          }).catch(() => {});
        }
      } catch (err) {
        console.error('[team-chat] Failed to fetch messages:', err);
      }
    };

    fetchMessages();
  }, [activeChannel?.id, api]);

  // Listen for WS messages
  useEffect(() => {
    if (!app.ws) return;

    const handleMessage = (event: any) => {
      try {
        const data = JSON.parse(typeof event.data === 'string' ? event.data : event);
        if (!data?.type?.startsWith('comm:')) return;

        switch (data.type) {
          case 'comm:message:new': {
            const { channelId, message } = data.payload;
            if (channelId === activeChannel?.id) {
              setMessages((prev) => [...prev, message]);
            } else {
              // Increment unread
              setUnreadCounts((prev) => ({
                ...prev,
                [channelId]: (prev[channelId] || 0) + 1,
              }));
            }
            break;
          }
          case 'comm:message:update': {
            const { messageId, message } = data.payload;
            setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, ...message } : m));
            break;
          }
          case 'comm:typing:start': {
            const { userId, channelId } = data.payload;
            if (channelId === activeChannel?.id && userId !== currentUser?.id) {
              setTypingUsers((prev) => prev.includes(userId) ? prev : [...prev, userId]);
              // Clear after 3s
              if (typingTimeouts.current[userId]) clearTimeout(typingTimeouts.current[userId]);
              typingTimeouts.current[userId] = setTimeout(() => {
                setTypingUsers((prev) => prev.filter((u) => u !== userId));
              }, 3000);
            }
            break;
          }
          case 'comm:typing:stop': {
            const { userId } = data.payload;
            setTypingUsers((prev) => prev.filter((u) => u !== userId));
            break;
          }
          case 'comm:member:joined':
          case 'comm:member:left':
            // Refresh channel list
            break;
        }
      } catch {}
    };

    app.ws.on('message', handleMessage);
    return () => app.ws.off('message', handleMessage);
  }, [app.ws, activeChannel?.id, currentUser?.id]);

  // Send message
  const sendMessage = useCallback(async (content: string) => {
    if (!activeChannel?.id || !content.trim()) return;
    try {
      await api.request({
        url: 'commMessages:create',
        method: 'post',
        data: {
          channelId: activeChannel.id,
          content: content.trim(),
          contentType: 'text',
        },
      });
    } catch (err) {
      console.error('[team-chat] Failed to send message:', err);
    }
  }, [activeChannel?.id, api]);

  // Create channel
  const createChannel = useCallback(async (values: any) => {
    try {
      const { data } = await api.request({
        url: 'commChannels:createWithOwner',
        method: 'post',
        data: values,
      });
      if (data?.data) {
        setChannels((prev) => [...prev, data.data]);
        setActiveChannel(data.data);
      }
    } catch (err) {
      console.error('[team-chat] Failed to create channel:', err);
    }
  }, [api]);

  // Load more messages (cursor-based)
  const loadMoreMessages = useCallback(async () => {
    if (!activeChannel?.id || messages.length === 0) return;
    const firstMsgId = messages[0]?.id;
    try {
      const { data } = await api.request({
        url: 'commMessages:listByChannel',
        method: 'post',
        params: { channelId: activeChannel.id, before: firstMsgId, limit: 50 },
      });
      const older = data?.data || [];
      setMessages((prev) => [...older, ...prev]);
      setHasMore(older.length >= 50);
    } catch (err) {
      console.error('[team-chat] Failed to load more messages:', err);
    }
  }, [activeChannel?.id, messages, api]);

  return (
    <ChatContext.Provider value={{
      channels, activeChannel, setActiveChannel, messages,
      sendMessage, createChannel, unreadCounts, typingUsers,
      currentUser, loading, loadMoreMessages, hasMore,
    }}>
      {children}
    </ChatContext.Provider>
  );
};
