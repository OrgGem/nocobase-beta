import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Button, Tooltip, Avatar, Badge, Space, Spin, message } from 'antd';
import {
  AudioOutlined,
  AudioMutedOutlined,
  VideoCameraOutlined,
  VideoCameraAddOutlined,
  DesktopOutlined,
  PhoneOutlined,
  ExpandOutlined,
  TeamOutlined,
  SettingOutlined,
} from '@ant-design/icons';

// Types for LiveKit (loaded dynamically to avoid build issues when livekit-client is optional)
interface LiveKitRoomState {
  connected: boolean;
  participants: Map<string, any>;
  localParticipant: any;
}

/**
 * VideoCallRoom — Full video call experience using LiveKit WebRTC.
 *
 * This component:
 * 1. Requests a LiveKit token from NocoBase server
 * 2. Connects to LiveKit SFU
 * 3. Publishes local camera + mic
 * 4. Renders remote participant video feeds
 * 5. Provides controls: mute, camera, screen share, leave
 */
export const VideoCallRoom: React.FC<{
  meetingId: string;
  onLeave: () => void;
}> = ({ meetingId, onLeave }) => {
  const api = useAPIClient();
  const [connecting, setConnecting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [participants, setParticipants] = useState<any[]>([]);
  const [meetingInfo, setMeetingInfo] = useState<any>(null);
  const [elapsedTime, setElapsedTime] = useState(0);

  const roomRef = useRef<any>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Connect to LiveKit room
  useEffect(() => {
    let mounted = true;

    const connectToRoom = async () => {
      try {
        // Step 1: Get token from NocoBase server
        const { data } = await api.request({
          url: 'commMeetings:joinCall',
          method: 'post',
          params: { filterByTk: meetingId },
        });

        const result = data?.data;
        if (!result?.token) {
          throw new Error('Failed to get meeting token');
        }

        setMeetingInfo(result.meeting);

        // Step 2: Dynamically import livekit-client (runtime-only, bypasses bundler static analysis)
        let LiveKit: any;
        try {
          // Construct the module name at runtime to avoid bundler resolution
          const moduleName = ['livekit', 'client'].join('-');
          LiveKit = await new Function('m', 'return import(m)')(moduleName);
        } catch {
          // livekit-client not installed — show instructions
          setError(
            'LiveKit client SDK not available. Install it with:\n' +
            'npm install livekit-client\n\n' +
            'And ensure LiveKit server is running at: ' + result.serverUrl
          );
          setConnecting(false);
          return;
        }

        // Step 3: Create room and connect
        const room = new LiveKit.Room({
          adaptiveStream: true,
          dynacast: true,
          videoCaptureDefaults: {
            resolution: LiveKit.VideoPresets.h720.resolution,
          },
        });

        roomRef.current = room;

        // Event: remote participant track subscribed
        room.on(LiveKit.RoomEvent.TrackSubscribed, () => {
          if (mounted) updateParticipants(room);
        });

        room.on(LiveKit.RoomEvent.TrackUnsubscribed, () => {
          if (mounted) updateParticipants(room);
        });

        room.on(LiveKit.RoomEvent.ParticipantConnected, () => {
          if (mounted) updateParticipants(room);
        });

        room.on(LiveKit.RoomEvent.ParticipantDisconnected, () => {
          if (mounted) updateParticipants(room);
        });

        room.on(LiveKit.RoomEvent.Disconnected, () => {
          if (mounted) handleLeave();
        });

        // Step 4: Connect to LiveKit server
        await room.connect(result.serverUrl, result.token);

        // Step 5: Enable camera and microphone
        await room.localParticipant.enableCameraAndMicrophone();

        // Attach local video
        const localVideoTrack = room.localParticipant.getTrackPublication(
          LiveKit.Track.Source.Camera
        )?.track;

        if (localVideoTrack && localVideoRef.current) {
          localVideoTrack.attach(localVideoRef.current);
        }

        if (mounted) {
          setConnecting(false);
          updateParticipants(room);

          // Start elapsed timer
          timerRef.current = setInterval(() => {
            setElapsedTime((prev) => prev + 1);
          }, 1000);
        }
      } catch (err: any) {
        console.error('[video-call] Connection failed:', err);
        if (mounted) {
          setError(err.message || 'Failed to connect to video call');
          setConnecting(false);
        }
      }
    };

    connectToRoom();

    return () => {
      mounted = false;
      if (timerRef.current) clearInterval(timerRef.current);
      if (roomRef.current) {
        roomRef.current.disconnect();
        roomRef.current = null;
      }
    };
  }, [meetingId, api]);

  const updateParticipants = (room: any) => {
    const parts: any[] = [];
    room.remoteParticipants.forEach((p: any) => {
      parts.push({
        sid: p.sid,
        identity: p.identity,
        name: p.name || p.identity,
        isSpeaking: p.isSpeaking,
        videoTrack: p.getTrackPublication('camera')?.track || null,
        audioTrack: p.getTrackPublication('microphone')?.track || null,
      });
    });
    setParticipants(parts);
  };

  // Controls
  const toggleMute = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    await room.localParticipant.setMicrophoneEnabled(isMuted);
    setIsMuted(!isMuted);
  }, [isMuted]);

  const toggleCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    await room.localParticipant.setCameraEnabled(isCameraOff);
    setIsCameraOff(!isCameraOff);
  }, [isCameraOff]);

  const toggleScreenShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.setScreenShareEnabled(!isScreenSharing);
      setIsScreenSharing(!isScreenSharing);
    } catch (err) {
      message.warning('Screen sharing cancelled');
    }
  }, [isScreenSharing]);

  const handleLeave = useCallback(async () => {
    if (roomRef.current) {
      roomRef.current.disconnect();
      roomRef.current = null;
    }
    if (timerRef.current) clearInterval(timerRef.current);
    onLeave();
  }, [onLeave]);

  const handleEndCall = useCallback(async () => {
    try {
      await api.request({
        url: 'commMeetings:endCall',
        method: 'post',
        params: { filterByTk: meetingId },
      });
    } catch (err) {
      console.error('[video-call] End call failed:', err);
    }
    handleLeave();
  }, [api, meetingId, handleLeave]);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  // Loading state
  if (connecting) {
    return (
      <div style={styles.loadingContainer}>
        <Spin size="large" />
        <div style={{ color: '#fff', marginTop: 16, fontSize: 16 }}>Connecting to meeting...</div>
        <div style={{ color: 'rgba(255,255,255,0.4)', marginTop: 4, fontSize: 13 }}>
          Setting up camera and microphone
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div style={styles.loadingContainer}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
        <div style={{ color: '#ff4d4f', marginBottom: 8, fontSize: 16, fontWeight: 600 }}>
          Connection Failed
        </div>
        <div style={{ color: 'rgba(255,255,255,0.5)', marginBottom: 24, maxWidth: 400, textAlign: 'center', whiteSpace: 'pre-line' }}>
          {error}
        </div>
        <Button onClick={onLeave} style={{ borderRadius: 8 }}>Go Back</Button>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Top Bar */}
      <div style={styles.topBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Badge status="processing" color="#52c41a" />
          <span style={{ color: '#fff', fontWeight: 600 }}>
            {meetingInfo?.title || `Meeting #${meetingId}`}
          </span>
          <span style={styles.timer}>{formatTime(elapsedTime)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <TeamOutlined style={{ color: 'rgba(255,255,255,0.5)' }} />
          <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>
            {participants.length + 1} participants
          </span>
        </div>
      </div>

      {/* Video Grid */}
      <div style={styles.videoGrid}>
        {/* Local Video */}
        <div style={styles.videoTile}>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            style={{
              ...styles.video,
              transform: 'scaleX(-1)', // Mirror local video
              opacity: isCameraOff ? 0 : 1,
            }}
          />
          {isCameraOff && (
            <div style={styles.cameraOffOverlay}>
              <Avatar size={64} style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', fontSize: 24 }}>
                You
              </Avatar>
            </div>
          )}
          <div style={styles.nameTag}>
            You {isMuted && '🔇'}
          </div>
        </div>

        {/* Remote Participants */}
        {participants.map((p) => (
          <RemoteParticipantTile key={p.sid} participant={p} />
        ))}

        {/* Empty slots for visual balance */}
        {participants.length === 0 && (
          <div style={{ ...styles.videoTile, ...styles.emptyTile }}>
            <div style={{ color: 'rgba(255,255,255,0.2)', textAlign: 'center' }}>
              <TeamOutlined style={{ fontSize: 32, marginBottom: 8 }} />
              <div>Waiting for others to join...</div>
            </div>
          </div>
        )}
      </div>

      {/* Control Bar */}
      <div style={styles.controlBar}>
        <Space size={12}>
          <Tooltip title={isMuted ? 'Unmute' : 'Mute'}>
            <Button
              shape="circle"
              size="large"
              icon={isMuted ? <AudioMutedOutlined /> : <AudioOutlined />}
              onClick={toggleMute}
              style={{
                ...styles.controlBtn,
                background: isMuted ? 'rgba(255,77,79,0.2)' : 'rgba(255,255,255,0.1)',
                color: isMuted ? '#ff4d4f' : '#fff',
                border: isMuted ? '1px solid rgba(255,77,79,0.3)' : '1px solid rgba(255,255,255,0.1)',
              }}
            />
          </Tooltip>

          <Tooltip title={isCameraOff ? 'Turn on camera' : 'Turn off camera'}>
            <Button
              shape="circle"
              size="large"
              icon={isCameraOff ? <VideoCameraAddOutlined /> : <VideoCameraOutlined />}
              onClick={toggleCamera}
              style={{
                ...styles.controlBtn,
                background: isCameraOff ? 'rgba(255,77,79,0.2)' : 'rgba(255,255,255,0.1)',
                color: isCameraOff ? '#ff4d4f' : '#fff',
                border: isCameraOff ? '1px solid rgba(255,77,79,0.3)' : '1px solid rgba(255,255,255,0.1)',
              }}
            />
          </Tooltip>

          <Tooltip title={isScreenSharing ? 'Stop sharing' : 'Share screen'}>
            <Button
              shape="circle"
              size="large"
              icon={<DesktopOutlined />}
              onClick={toggleScreenShare}
              style={{
                ...styles.controlBtn,
                background: isScreenSharing ? 'rgba(99,102,241,0.3)' : 'rgba(255,255,255,0.1)',
                color: isScreenSharing ? '#8b5cf6' : '#fff',
                border: isScreenSharing ? '1px solid rgba(99,102,241,0.4)' : '1px solid rgba(255,255,255,0.1)',
              }}
            />
          </Tooltip>

          {/* Leave / End call */}
          <Tooltip title="Leave call">
            <Button
              shape="circle"
              size="large"
              icon={<PhoneOutlined style={{ transform: 'rotate(135deg)' }} />}
              onClick={handleEndCall}
              style={{
                ...styles.controlBtn,
                background: 'linear-gradient(135deg, #ff4d4f, #cf1322)',
                color: '#fff',
                border: 'none',
                boxShadow: '0 4px 12px rgba(255,77,79,0.4)',
              }}
            />
          </Tooltip>
        </Space>
      </div>
    </div>
  );
};

/**
 * RemoteParticipantTile — renders a single remote user's video/audio feed.
 */
const RemoteParticipantTile: React.FC<{ participant: any }> = ({ participant }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (participant.videoTrack && videoRef.current) {
      participant.videoTrack.attach(videoRef.current);
    }
    if (participant.audioTrack && audioRef.current) {
      participant.audioTrack.attach(audioRef.current);
    }

    return () => {
      if (participant.videoTrack) participant.videoTrack.detach();
      if (participant.audioTrack) participant.audioTrack.detach();
    };
  }, [participant.videoTrack, participant.audioTrack]);

  const hasVideo = !!participant.videoTrack;

  return (
    <div style={{
      ...videoStyles.tile,
      border: participant.isSpeaking ? '2px solid #52c41a' : '2px solid transparent',
    }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{ ...videoStyles.video, opacity: hasVideo ? 1 : 0 }}
      />
      <audio ref={audioRef} autoPlay />

      {!hasVideo && (
        <div style={videoStyles.cameraOff}>
          <Avatar size={64} style={{ background: 'linear-gradient(135deg, #10b981, #059669)', fontSize: 24 }}>
            {(participant.name || '?')[0]}
          </Avatar>
        </div>
      )}

      <div style={videoStyles.nameTag}>
        {participant.isSpeaking && <Badge status="processing" color="#52c41a" />}
        {participant.name || participant.identity}
      </div>
    </div>
  );
};

// ──── Styles ────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex', flexDirection: 'column', height: '100%',
    background: 'linear-gradient(180deg, #0a0a12 0%, #0d0d18 100%)',
  },
  loadingContainer: {
    display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
    height: '100%', background: '#0a0a12',
  },
  topBar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 20px',
    background: 'rgba(0,0,0,0.3)',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  timer: {
    color: 'rgba(255,255,255,0.5)', fontSize: 13,
    background: 'rgba(255,255,255,0.06)', padding: '2px 10px',
    borderRadius: 12, fontVariantNumeric: 'tabular-nums',
  },
  videoGrid: {
    flex: 1, display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: 8, padding: 8, overflow: 'auto',
    alignContent: 'center',
  },
  videoTile: {
    position: 'relative', borderRadius: 12, overflow: 'hidden',
    background: '#111118', aspectRatio: '16/9',
    border: '2px solid transparent',
    transition: 'border-color 0.2s ease',
  },
  video: {
    width: '100%', height: '100%', objectFit: 'cover',
    borderRadius: 10,
  },
  cameraOffOverlay: {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'linear-gradient(135deg, #111118, #1a1a28)',
  },
  nameTag: {
    position: 'absolute', bottom: 8, left: 8,
    background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
    padding: '3px 10px', borderRadius: 6,
    color: '#fff', fontSize: 12, fontWeight: 500,
  },
  emptyTile: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: '2px dashed rgba(255,255,255,0.08)',
  },
  controlBar: {
    display: 'flex', justifyContent: 'center', alignItems: 'center',
    padding: '16px 20px',
    background: 'rgba(0,0,0,0.4)',
    borderTop: '1px solid rgba(255,255,255,0.06)',
  },
  controlBtn: {
    width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'all 0.2s ease',
  },
};

const videoStyles: Record<string, React.CSSProperties> = {
  tile: {
    position: 'relative', borderRadius: 12, overflow: 'hidden',
    background: '#111118', aspectRatio: '16/9',
    transition: 'border-color 0.3s ease',
  },
  video: {
    width: '100%', height: '100%', objectFit: 'cover', borderRadius: 10,
  },
  cameraOff: {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'linear-gradient(135deg, #111118, #1a1a28)',
  },
  nameTag: {
    position: 'absolute', bottom: 8, left: 8,
    background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
    padding: '3px 10px', borderRadius: 6,
    color: '#fff', fontSize: 12, fontWeight: 500,
    display: 'flex', alignItems: 'center', gap: 6,
  },
};

export default VideoCallRoom;
