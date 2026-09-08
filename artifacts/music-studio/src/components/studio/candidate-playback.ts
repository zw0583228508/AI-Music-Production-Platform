import type { AudioTransportStatus } from "./use-audio-transport";

export type CandidatePlaybackPresentation = {
  active: boolean;
  playing: boolean;
  disabled: boolean;
  label: string;
  text: "Unavailable" | "Pause" | "Play";
};

export function getCandidatePlaybackPresentation({
  candidateId,
  candidateLabel,
  activeCandidateId,
  hasAudio,
  transportStatus,
}: {
  candidateId: string;
  candidateLabel: string;
  activeCandidateId: string | null;
  hasAudio: boolean;
  transportStatus: AudioTransportStatus;
}): CandidatePlaybackPresentation {
  const active = activeCandidateId === candidateId;
  const playing = active && transportStatus === "playing";

  if (!hasAudio) {
    return {
      active,
      playing: false,
      disabled: true,
      label: `${candidateLabel} render unavailable`,
      text: "Unavailable",
    };
  }

  return {
    active,
    playing,
    disabled: active && transportStatus === "loading",
    label: playing ? `Pause ${candidateLabel}` : `Play ${candidateLabel}`,
    text: playing ? "Pause" : "Play",
  };
}