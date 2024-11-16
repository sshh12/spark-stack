'use client';

import { useEffect, useState, useRef } from 'react';
import { useUser } from '@/context/user-context';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ProjectWebSocketService } from '@/lib/project-websocket';
import { api } from '@/lib/api';
import { Chat } from './components/Chat';
import { RightPanel } from './components/RightPanel';

export default function WorkspacePage({ chatId }) {
  const { addChat, team } = useUser();
  const router = useRouter();
  const [projectId, setProjectId] = useState(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [chatTitle, setChatTitle] = useState('New Chat');
  const [projectPreviewUrl, setProjectPreviewUrl] = useState(null);
  const [projectFileTree, setProjectFileTree] = useState([]);
  const [projectStackPackId, setProjectStackPackId] = useState(null);
  const [suggestedFollowUps, setSuggestedFollowUps] = useState([]);
  const [previewHash, setPreviewHash] = useState(1);
  const [status, setStatus] = useState('NEW_CHAT');
  const webSocketRef = useRef(null);

  useEffect(() => {
    if (!localStorage.getItem('token')) {
      router.push('/');
    }
    if (!chatId) {
      router.push('/chats/new');
    }
  }, [chatId]);

  const initializeWebSocket = async (wsProjectId) => {
    if (webSocketRef.current) {
      webSocketRef.current.disconnect();
    }
    const ws = new ProjectWebSocketService(wsProjectId);
    webSocketRef.current = ws;

    const connectWS = async () => {
      try {
        await new Promise((resolve, reject) => {
          ws.connect();
          ws.ws.onopen = () => resolve();
          ws.ws.onerror = (error) => reject(error);
          ws.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            handleSocketMessage(data);
          };
          ws.ws.onclose = (e) => {
            setStatus('DISCONNECTED');
            console.log('WebSocket connection closed', e.code, e.reason);
            if ([1002, 1003].includes(e.code)) {
              initializeWebSocket(chatId);
            }
          };
          setTimeout(
            () => reject(new Error('WebSocket connection timeout')),
            5000
          );
        });

        const handleSocketMessage = (data) => {
          console.log('handleMessage', data);
          if (data.for_type === 'status') {
            handleStatus(data);
          } else if (data.for_type === 'chat_update') {
            handleChatUpdate(data);
          } else if (data.for_type === 'chat_chunk') {
            handleChatChunk(data);
          }
        };

        const handleStatus = (data) => {
          setStatus(data.sandbox_status);
          if (data.tunnels) {
            setProjectPreviewUrl(data.tunnels[3000]);
          }
          if (data.file_paths) {
            setProjectFileTree(data.file_paths);
          }
        };

        const handleChatUpdate = (data) => {
          setMessages((prev) => {
            const existingMessageIndex = prev.findIndex(
              (m) => m.id === data.message.id
            );
            if (existingMessageIndex >= 0) {
              return [
                ...prev.slice(0, existingMessageIndex),
                data.message,
                ...prev.slice(existingMessageIndex + 1),
              ];
            }
            const lastMessage = prev[prev.length - 1];
            if (
              lastMessage?.role === 'assistant' &&
              data.message.role === 'assistant'
            ) {
              return [
                ...prev.slice(0, -1),
                { ...lastMessage, content: data.message.content },
              ];
            }
            return [...prev, data.message];
          });
          if (data.follow_ups) {
            setSuggestedFollowUps(data.follow_ups);
          }
          setPreviewHash((prev) => prev + 1);
        };

        const handleChatChunk = (data) => {
          setMessages((prev) => {
            const lastMessage = prev[prev.length - 1];
            if (lastMessage?.role === 'assistant') {
              return [
                ...prev.slice(0, -1),
                { ...lastMessage, content: lastMessage.content + data.content },
              ];
            }
            return [...prev, { role: 'assistant', content: data.content }];
          });
        };

        return ws;
      } catch (error) {
        console.error('WebSocket connection failed:', error);
        setStatus({ status: 'Disconnected', color: 'bg-gray-500' });
      }
    };

    await connectWS();
    return { ws };
  };

  useEffect(() => {
    if (chatId !== 'new') {
      initializeWebSocket(chatId).catch((error) => {
        console.error('Failed to initialize WebSocket:', error);
      });
    }
    return () => {
      if (webSocketRef.current) {
        webSocketRef.current.disconnect();
      }
    };
  }, [chatId]);

  const handleStackPackSelect = (stackPackId) => {
    setProjectStackPackId(stackPackId);
  };

  const handleProjectSelect = (projectId) => {
    setProjectId(projectId);
  };

  const handleSendMessage = async (message) => {
    if (!message.content.trim() && message.images.length === 0) return;

    const userMessage = {
      role: 'user',
      content: message.content,
      images: message.images || [],
    };
    if (chatId === 'new') {
      const chat = await api.createChat({
        name: message.content,
        description: `Project started on ${new Date().toLocaleDateString()}`,
        stack_id: projectStackPackId,
        project_id: projectId,
        team_id: team.id,
      });
      addChat(chat);
      router.push(
        `/chats/${chat.id}?message=${encodeURIComponent(
          JSON.stringify(userMessage)
        )}`
      );
    } else {
      webSocketRef.current.sendMessage(userMessage);
    }
  };

  useEffect(() => {
    (async () => {
      if (chatId !== 'new') {
        setStatus('DISCONNECTED');
        const chat = await api.getChat(chatId);
        setChatTitle(chat.name);
        const existingMessages =
          chat?.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })) || [];
        setMessages(existingMessages);
      } else {
        setChatTitle('New Chat');
        setMessages([]);
        setProjectPreviewUrl(null);
        setProjectFileTree([]);
        setStatus('NEW_CHAT');
      }
    })();
  }, [chatId]);

  useEffect(() => {
    (async () => {
      if (status === 'READY') {
        const params = new URLSearchParams(window.location.search);
        const messageParam = params.get('message');
        if (messageParam) {
          try {
            const message = JSON.parse(decodeURIComponent(messageParam));
            const searchParams = new URLSearchParams(window.location.search);
            searchParams.delete('message');
            router.replace(
              `${window.location.pathname}?${searchParams.toString()}`,
              {
                scroll: false,
              }
            );
            await webSocketRef.current.sendMessage(message);
          } catch (error) {
            console.error('Failed to process message parameter:', error);
          }
        }
      }
    })();
  }, [chatId, status]);

  return (
    <div className="flex h-screen bg-background">
      <div className="flex-1 flex flex-col md:flex-row">
        {!isPreviewOpen && (
          <div className="md:hidden fixed top-4 right-4 z-40">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsPreviewOpen(!isPreviewOpen)}
            >
              View
            </Button>
          </div>
        )}
        <Chat
          connected={!!webSocketRef.current}
          messages={messages}
          onSendMessage={handleSendMessage}
          projectTitle={chatTitle}
          status={status}
          onProjectSelect={handleProjectSelect}
          onStackSelect={handleStackPackSelect}
          showStackPacks={chatId === 'new'}
          suggestedFollowUps={suggestedFollowUps}
        />
        <RightPanel
          isOpen={isPreviewOpen}
          onClose={() => setIsPreviewOpen(false)}
          projectPreviewUrl={
            projectPreviewUrl ? `${projectPreviewUrl}?v=${previewHash}` : null
          }
          projectFileTree={projectFileTree}
          projectId={projectId}
          chatId={chatId}
        />
      </div>
    </div>
  );
}
