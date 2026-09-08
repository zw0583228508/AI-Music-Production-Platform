import { useCallback, useEffect, useRef, useState } from "react";

export type AudioTransportStatus =
  | "unavailable"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "error";

export type AudioTransport = {
  status: AudioTransportStatus;
  currentTime: number;
  duration: number;
  error: string | null;
  play: () => Promise<void>;
  pause: () => void;
  toggle: () => void;
  stop: () => void;
  seek: (time: number) => void;
  retry: () => void;
};

function clampTime(time: number, duration: number): number {
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, Math.min(duration > 0 ? duration : time, time));
}

export function getSourceChangePlayback(
  previousSource: string | null,
  nextSource: string | null,
  currentTime: number,
  paused: boolean,
): { pendingTime: number; resumeAfterLoad: boolean } {
  const switchingSource = Boolean(
    previousSource && nextSource && previousSource !== nextSource,
  );
  return {
    pendingTime: switchingSource ? currentTime : 0,
    resumeAfterLoad: switchingSource && !paused,
  };
}

export function getSynchronizedSourceTime(
  pendingTime: number,
  mediaDuration: number,
  durationHint: number,
): number {
  return clampTime(pendingTime, mediaDuration || durationHint);
}

export function useAudioTransport(
  src: string | null,
  durationHint = 0,
): AudioTransport {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const playAttemptRef = useRef(0);
  const sourceRef = useRef<string | null>(null);
  const pendingSourceTimeRef = useRef(0);
  const resumeAfterSourceChangeRef = useRef(false);
  const durationHintRef = useRef(durationHint);
  durationHintRef.current = durationHint;
  const [status, setStatus] = useState<AudioTransportStatus>(
    src ? "loading" : "unavailable",
  );
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationHint);
  const [error, setError] = useState<string | null>(null);

  const stopAnimation = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const syncTime = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTime(audio.currentTime);
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      setDuration(audio.duration);
    }
    if (!audio.paused) {
      frameRef.current = window.requestAnimationFrame(syncTime);
    } else {
      frameRef.current = null;
    }
  }, []);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "metadata";
    audioRef.current = audio;
    const handleLoadStart = () => {
      setError(null);
      setStatus("loading");
    };
    const handleMetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
      const synchronizedTime = getSynchronizedSourceTime(
        pendingSourceTimeRef.current,
        audio.duration,
        durationHintRef.current,
      );
      audio.currentTime = synchronizedTime;
      setCurrentTime(synchronizedTime);
      pendingSourceTimeRef.current = 0;
      setStatus("paused");
      if (resumeAfterSourceChangeRef.current) {
        resumeAfterSourceChangeRef.current = false;
        void audio.play();
      }
    };
    const handleCanPlay = () => setStatus(audio.paused ? "ready" : "playing");
    const handlePlay = () => {
      setStatus("playing");
      frameRef.current = window.requestAnimationFrame(syncTime);
    };
    const handlePause = () => {
      stopAnimation();
      setCurrentTime(audio.currentTime);
      setStatus(
        audio.currentTime >= (audio.duration || durationHintRef.current) - 0.05
          ? "ready"
          : "paused",
      );
    };
    const handleEnded = () => {
      stopAnimation();
      setCurrentTime(audio.duration || durationHintRef.current);
      setStatus("ready");
    };
    const handleError = () => {
      stopAnimation();
      setStatus("error");
      setError(
        "Audio could not be loaded. Check that the source is ready, then try again.",
      );
    };

    audio.addEventListener("loadstart", handleLoadStart);
    audio.addEventListener("loadedmetadata", handleMetadata);
    audio.addEventListener("canplay", handleCanPlay);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);

    return () => {
      playAttemptRef.current += 1;
      stopAnimation();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audioRef.current = null;
      audio.removeEventListener("loadstart", handleLoadStart);
      audio.removeEventListener("loadedmetadata", handleMetadata);
      audio.removeEventListener("canplay", handleCanPlay);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
    };
  }, [stopAnimation, syncTime]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const previousSource = sourceRef.current;
    const sourceChange = getSourceChangePlayback(
      previousSource,
      src,
      audio.currentTime,
      audio.paused,
    );
    pendingSourceTimeRef.current = sourceChange.pendingTime;
    resumeAfterSourceChangeRef.current = sourceChange.resumeAfterLoad;
    sourceRef.current = src;
    playAttemptRef.current += 1;
    stopAnimation();
    audio.pause();
    audio.removeAttribute("src");
    setCurrentTime(pendingSourceTimeRef.current);
    setDuration(durationHintRef.current);
    setError(null);
    setStatus(src ? "loading" : "unavailable");
    if (src) {
      audio.src = src;
      audio.load();
    }
  }, [src, stopAnimation]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!Number.isFinite(audio?.duration) && durationHint > 0) {
      setDuration(durationHint);
    }
  }, [durationHint]);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !src) {
      setStatus("unavailable");
      return;
    }
    setError(null);
    setStatus("loading");
    const playAttempt = ++playAttemptRef.current;
    try {
      await audio.play();
    } catch (playError) {
      if (playAttempt !== playAttemptRef.current) return;
      setStatus("error");
      setError(
        playError instanceof DOMException && playError.name === "NotAllowedError"
          ? "Your browser blocked audio playback. Click play again to allow audio in this tab."
          : "Audio playback could not start. Try loading the source again.",
      );
    }
  }, [src]);

  const pause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    playAttemptRef.current += 1;
    stopAnimation();
    audio.pause();
    setCurrentTime(audio.currentTime);
    setStatus("paused");
  }, [stopAnimation]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !src) {
      setStatus("unavailable");
      return;
    }
    if (!audio.paused) {
      playAttemptRef.current += 1;
      stopAnimation();
      audio.pause();
      setCurrentTime(audio.currentTime);
      setStatus("paused");
      return;
    }
    void play();
  }, [play, src, stopAnimation]);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    playAttemptRef.current += 1;
    stopAnimation();
    audio.pause();
    audio.currentTime = 0;
    setCurrentTime(0);
    setStatus(src ? "ready" : "unavailable");
  }, [src]);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const nextTime = clampTime(time, audio.duration || duration);
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }, [duration]);

  const retry = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !src) return;
    playAttemptRef.current += 1;
    setError(null);
    setStatus("loading");
    audio.load();
  }, [src]);

  return { status, currentTime, duration, error, play, pause, toggle, stop, seek, retry };
}