import { useEffect, useRef } from 'react';

interface VideoPlayerProps {
  videoUrl: string | null;
  videoName: string | null;
  onTimeUpdate: (t: number) => void;
  onDurationChange: (d: number) => void;
  onPlayStateChange: (playing: boolean) => void;
  onLoadFile: (file: File) => void;
  registerControls: (controls: { seek: (t: number) => void; togglePlay: () => void }) => void;
}

export default function VideoPlayer(props: VideoPlayerProps) {
  const {
    videoUrl,
    videoName,
    onTimeUpdate,
    onDurationChange,
    onPlayStateChange,
    onLoadFile,
    registerControls,
  } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekingRef = useRef(false);

  useEffect(() => {
    registerControls({
      seek: (t) => {
        const v = videoRef.current;
        if (!v || !isFinite(v.duration)) return;
        seekingRef.current = true;
        v.currentTime = Math.min(Math.max(0, t), v.duration);
      },
      togglePlay: () => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) void v.play();
        else v.pause();
      },
    });
  }, [registerControls]);

  return (
    <div className="video-panel">
      {videoUrl ? (
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          className="video-el"
          onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => onDurationChange(e.currentTarget.duration)}
          onDurationChange={(e) => onDurationChange(e.currentTarget.duration)}
          onPlay={() => onPlayStateChange(true)}
          onPause={() => onPlayStateChange(false)}
          onSeeked={() => {
            seekingRef.current = false;
            if (videoRef.current) onTimeUpdate(videoRef.current.currentTime);
          }}
        />
      ) : (
        <label className="video-empty">
          <input
            type="file"
            accept="video/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onLoadFile(f);
            }}
          />
          <div className="video-empty-inner">
            <strong>加载视频以同步校对</strong>
            <span>点击选择本地视频（可选，不加载也能调整时间轴）</span>
          </div>
        </label>
      )}
      {videoName && <div className="video-name">🎬 {videoName}</div>}
    </div>
  );
}
