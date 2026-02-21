import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_WAVEFORM_BARS = 16;
const DEFAULT_WAVEFORM_VALUES = Array.from({ length: DEFAULT_WAVEFORM_BARS }, () => 0);
const AUDIO_BITS_PER_SECOND = 24_000;
const SMOOTHING_FACTOR = 0.35;
export const MAX_VOICE_RECORDING_DURATION_MS = 5 * 60 * 1000;

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pickRecorderMimeType(): string | undefined {
  for (const mimeType of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  return undefined;
}

function buildWaveformBars(dataArray: Uint8Array, count: number): number[] {
  if (dataArray.length === 0 || count <= 0) {
    return DEFAULT_WAVEFORM_VALUES;
  }

  const bucketSize = Math.max(1, Math.floor(dataArray.length / count));
  const bars: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const start = index * bucketSize;
    const end = Math.min(dataArray.length, start + bucketSize);
    let sum = 0;

    for (let i = start; i < end; i += 1) {
      sum += dataArray[i] ?? 0;
    }

    const average = end > start ? sum / (end - start) : 0;
    bars.push(clamp(average / 255, 0, 1));
  }

  return bars;
}

export interface VoiceRecordingResult {
  blob: Blob;
  durationMs: number;
}

interface UseVoiceRecorderResult {
  isRecording: boolean;
  isRequestingPermission: boolean;
  durationMs: number;
  waveformBars: number[];
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<VoiceRecordingResult | null>;
  cancelRecording: () => void;
}

export function useVoiceRecorder(): UseVoiceRecorderResult {
  const [isRecording, setIsRecording] = useState(false);
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const [waveformBars, setWaveformBars] = useState<number[]>(DEFAULT_WAVEFORM_VALUES);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const durationIntervalRef = useRef<number | null>(null);
  const stopResolverRef = useRef<((result: VoiceRecordingResult | null) => void) | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const smoothedBarsRef = useRef<number[]>(DEFAULT_WAVEFORM_VALUES);

  const resetDurationTimer = useCallback(() => {
    if (durationIntervalRef.current !== null) {
      window.clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
  }, []);

  const teardownAnalyzer = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    analyserNodeRef.current = null;
  }, []);

  const stopMediaStream = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    mediaStreamRef.current = null;
  }, []);

  const cleanupAfterRecording = useCallback(() => {
    resetDurationTimer();
    teardownAnalyzer();
    stopMediaStream();
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    smoothedBarsRef.current = DEFAULT_WAVEFORM_VALUES;
    setIsRecording(false);
    setDurationMs(0);
    setWaveformBars(DEFAULT_WAVEFORM_VALUES);
  }, [resetDurationTimer, stopMediaStream, teardownAnalyzer]);

  const stopRecording = useCallback(async (): Promise<VoiceRecordingResult | null> => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") {
      return null;
    }

    return new Promise<VoiceRecordingResult | null>((resolve) => {
      stopResolverRef.current = resolve;
      recorder.stop();
    });
  }, []);

  const cancelRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      stopResolverRef.current = null;
      recorder.stop();
    } else {
      cleanupAfterRecording();
    }
  }, [cleanupAfterRecording]);

  const startRecording = useCallback(async () => {
    if (isRecording || isRequestingPermission) {
      return;
    }

    if (
      typeof MediaRecorder === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      throw new Error("Voice recording is not supported in this browser.");
    }

    setIsRequestingPermission(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });

      const mimeType = pickRecorderMimeType();
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });

      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      startedAtRef.current = Date.now();

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const recordingDuration = Math.max(0, Date.now() - startedAtRef.current);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
        const resolver = stopResolverRef.current;
        stopResolverRef.current = null;

        cleanupAfterRecording();

        if (resolver) {
          if (blob.size === 0) {
            resolver(null);
          } else {
            resolver({ blob, durationMs: recordingDuration });
          }
        }
      };

      recorder.onerror = () => {
        const resolver = stopResolverRef.current;
        stopResolverRef.current = null;
        cleanupAfterRecording();
        resolver?.(null);
      };

      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserNodeRef.current = analyser;

      const frequencyData = new Uint8Array(analyser.frequencyBinCount);
      const drawWaveform = () => {
        const activeAnalyser = analyserNodeRef.current;
        if (!activeAnalyser) {
          return;
        }

        activeAnalyser.getByteFrequencyData(frequencyData);
        const rawBars = buildWaveformBars(frequencyData, DEFAULT_WAVEFORM_BARS);
        const prev = smoothedBarsRef.current;
        const smoothed = rawBars.map((bar, i) => {
          const prevVal = prev[i] ?? 0;
          return prevVal + (bar - prevVal) * SMOOTHING_FACTOR;
        });
        smoothedBarsRef.current = smoothed;
        setWaveformBars(smoothed);
        animationFrameRef.current = window.requestAnimationFrame(drawWaveform);
      };

      animationFrameRef.current = window.requestAnimationFrame(drawWaveform);

      durationIntervalRef.current = window.setInterval(() => {
        const elapsed = Math.max(0, Date.now() - startedAtRef.current);
        setDurationMs(elapsed);
      }, 100);

      recorder.start(150);
      setIsRecording(true);
    } catch (error) {
      cleanupAfterRecording();
      throw error;
    } finally {
      setIsRequestingPermission(false);
    }
  }, [cleanupAfterRecording, isRecording, isRequestingPermission]);

  useEffect(() => {
    return () => {
      cancelRecording();
    };
  }, [cancelRecording]);

  return {
    isRecording,
    isRequestingPermission,
    durationMs,
    waveformBars,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
