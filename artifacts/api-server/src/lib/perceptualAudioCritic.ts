import type {
  CandidateAudioCriticDimension,
  CandidateAudioCriticDimensionResult,
  CandidateAudioCriticReport,
  SongModelData,
} from "@workspace/db";

const dimensions: CandidateAudioCriticDimension[] = [
  "vocalFit", "masking", "balance", "dynamics", "artifactsAndDistortion", "transitions", "repetition",
];
const analyzerVersion = "perceptual-audio-critic-v1";

type Window = { start: number; end: number; rms: number; peak: number; zcr: number };

function unavailable(explanation: string): CandidateAudioCriticDimensionResult {
  return { status: "unavailable", score: null, explanation, findings: [] };
}
function available(
  score: number,
  explanation: string,
  findings: CandidateAudioCriticDimensionResult["findings"] = [],
): CandidateAudioCriticDimensionResult {
  return { status: "available", score: Math.max(0, Math.min(1, score)), explanation, findings };
}

function containsOnlyFiniteSamples(pcm: Float32Array): boolean {
  for (let index = 0; index < pcm.length; index += 1) {
    if (!Number.isFinite(pcm[index])) return false;
  }
  return true;
}

/** PCM-only, fixed-window metrics. This intentionally has no model/provider dependency. */
export function evaluateRenderedPcm(input: {
  pcm: Float32Array | null | undefined;
  sampleRate: number;
  channels: 1 | 2;
  artifactId: string;
  artifactSha256: string;
  renderedTracks?: Array<{ id: string; pcm: Float32Array; channels: 1 | 2; sampleRate: number }>;
  vocalEvidence?: NonNullable<SongModelData["vocalEvidence"]>;
  analyzedDurationSeconds?: number;
  /** @deprecated use renderedTracks; retained for callers with a single render. */
  renderedTrackIds?: string[];
}): CandidateAudioCriticReport {
  const base = Object.fromEntries(dimensions.map((name) => [name, unavailable("Rendered PCM was unavailable.")])) as
    Record<CandidateAudioCriticDimension, CandidateAudioCriticDimensionResult>;
  if (!input.pcm || !Number.isFinite(input.sampleRate) || input.sampleRate < 1 || !input.channels) {
    return { version: analyzerVersion, status: "unavailable", score: null,
      coverage: { availableDimensions: 0, totalDimensions: 7, sufficient: false }, evidence: null, dimensions: base };
  }
  if (!/^[a-f0-9]{64}$/.test(input.artifactSha256) || !input.artifactId) {
    return { version: analyzerVersion, status: "failed", score: null,
      coverage: { availableDimensions: 0, totalDimensions: 7, sufficient: false }, evidence: null, dimensions: base };
  }
  const interleaved = input.pcm;
  if (interleaved.length < input.sampleRate * input.channels || interleaved.length % input.channels ||
    !containsOnlyFiniteSamples(interleaved)) {
    return { version: analyzerVersion, status: "insufficient", score: null,
      coverage: { availableDimensions: 0, totalDimensions: 7, sufficient: false },
      evidence: { artifactId: input.artifactId, artifactSha256: input.artifactSha256, sampleRate: input.sampleRate, analyzerVersion },
      dimensions: base };
  }
  const frames = interleaved.length / input.channels;
  const pcm = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < input.channels; channel++) sum += interleaved[frame * input.channels + channel];
    pcm[frame] = sum / input.channels;
  }
  const windowSize = Math.max(1, Math.floor(input.sampleRate / 2));
  const windows: Window[] = [];
  for (let start = 0; start < pcm.length; start += windowSize) {
    const end = Math.min(pcm.length, start + windowSize);
    let energy = 0, peak = 0, crossings = 0;
    for (let index = start; index < end; index++) {
      const sample = pcm[index];
      energy += sample * sample; peak = Math.max(peak, Math.abs(sample));
      if (index > start && (sample >= 0) !== (pcm[index - 1] >= 0)) crossings++;
    }
    windows.push({ start: start / input.sampleRate, end: end / input.sampleRate,
      rms: Math.sqrt(energy / (end - start)), peak, zcr: crossings / Math.max(1, end - start) });
  }
  const mean = windows.reduce((sum, window) => sum + window.rms, 0) / windows.length;
  const variance = windows.reduce((sum, window) => sum + (window.rms - mean) ** 2, 0) / windows.length;
  const actualTracks = (input.renderedTracks ?? []).filter((track) =>
    Boolean(track.id) && track.pcm instanceof Float32Array && track.sampleRate === input.sampleRate &&
    track.pcm.length === frames * track.channels && containsOnlyFiniteSamples(track.pcm));
  const attributedTracks = actualTracks.length === 1 ? [actualTracks[0].id] :
    input.renderedTrackIds?.length === 1 ? input.renderedTrackIds : undefined;
  const finding = (id: string, window: Window, confidence: number, recommendation: string) => ({
    id: `${id}-${Math.round(window.start * 1000)}`, startSeconds: window.start, endSeconds: window.end,
    ...(attributedTracks ? { affectedTrackIds: attributedTracks } : {}),
    confidence, provenance: "rendered_pcm" as const, recommendation,
  });
  const clipped = windows.filter((window) => window.peak >= .995);
  const jump = windows.find((window, index) => index > 0 && Math.abs(window.rms - windows[index - 1].rms) > Math.max(.12, mean * .9));
  const repeated = windows.find((window, index) => index > 1 &&
    Math.abs(window.rms - windows[index - 2].rms) < .002 && Math.abs(window.zcr - windows[index - 2].zcr) < .002);
  const quiet = windows.find((window) => window.rms < .002);
  const vocalProvenance = input.vocalEvidence?.provenance;
  const renderedDuration = frames / input.sampleRate;
  const evidenceDuration = Number.isFinite(input.analyzedDurationSeconds)
    ? Math.min(renderedDuration, input.analyzedDurationSeconds!)
    : renderedDuration;
  const canonicalVocalRoles = new Set(["vocal", "vocals", "voice"]);
  const normalizedStemRole = vocalProvenance?.sourceStemRole.trim().toLowerCase();
  const validVocalProvenance = input.vocalEvidence?.status === "detected" &&
    Boolean(vocalProvenance &&
      normalizedStemRole && canonicalVocalRoles.has(normalizedStemRole) &&
      vocalProvenance.objectPath.trim() &&
      vocalProvenance.provider.trim() &&
      (vocalProvenance.contentChecksum === undefined ||
        /^[a-f0-9]{64}$/i.test(vocalProvenance.contentChecksum)));
  const verifiedVocalWindows = validVocalProvenance &&
    input.vocalEvidence!.observedVoicedWindows.every((window) =>
      Number.isFinite(window.start) && Number.isFinite(window.end) &&
      window.start >= 0 && window.end > window.start && window.end <= evidenceDuration)
    ? input.vocalEvidence!.observedVoicedWindows
    : [];
  const vocalWindow = verifiedVocalWindows.find((window) => window.end > window.start);
  const vocalEnergy = vocalWindow ? (() => {
    const start = Math.floor(vocalWindow.start * input.sampleRate);
    const end = Math.min(pcm.length, Math.ceil(vocalWindow.end * input.sampleRate));
    let energy = 0;
    for (let index = start; index < end; index++) energy += pcm[index] * pcm[index];
    return Math.sqrt(energy / Math.max(1, end - start));
  })() : 0;
  base.vocalFit = vocalWindow
    ? available(vocalEnergy > .003 && vocalEnergy < .45 ? .85 : .35,
      "Verified vocal-stem activity windows were compared with rendered master energy.",
      vocalEnergy <= .003 || vocalEnergy >= .45 ? [{ id: `vocal-support-${Math.round(vocalWindow.start * 1000)}`, startSeconds: vocalWindow.start,
        endSeconds: vocalWindow.end, confidence: .8, provenance: "rendered_pcm",
        recommendation: vocalEnergy >= .45
          ? "Reduce accompaniment energy in this verified vocal interval."
          : "Increase accompaniment support only in this verified vocal interval." }] : [])
    : unavailable("No verified vocal activity windows are available; vocal fit is abstained.");
  const trackRms = actualTracks.map((track) => {
    let total = 0; for (const value of track.pcm) total += value * value;
    return Math.sqrt(total / track.pcm.length);
  });
  const dominance = trackRms.length ? Math.max(...trackRms) / Math.max(.00001, trackRms.reduce((sum, value) => sum + value, 0)) : 0;
  const dominantTrackIds = actualTracks.filter((_, index) => trackRms[index] === Math.max(...trackRms)).map((track) => track.id);
  const dominanceFinding = dominance > .7 ? [{
    id: "track-energy-dominance-0", startSeconds: 0, endSeconds: frames / input.sampleRate,
    affectedTrackIds: dominantTrackIds, confidence: .86, provenance: "rendered_pcm" as const,
    recommendation: "Reduce the dominant rendered tracks or create spectral/level space in this interval.",
  }] : [];
  base.masking = actualTracks.length >= 2
    ? available(Math.max(0, 1 - Math.max(0, dominance - .7) * 2),
      "Simultaneous rendered track energy shares support masking analysis.", dominanceFinding)
    : unavailable("Masking requires at least two actual rendered track PCM arrays; full-mix analysis abstains.");
  base.balance = actualTracks.length >= 2
    ? available(Math.max(0, 1 - Math.max(0, dominance - .65) * 2),
      "Rendered per-track RMS shares support relative-balance analysis.", dominanceFinding)
    : unavailable("Balance requires at least two actual rendered track PCM arrays; full-mix analysis abstains.");
  base.dynamics = available(Math.min(1, .55 + Math.min(.4, Math.sqrt(variance) * 3)),
    "Short-window RMS variation was measured from rendered PCM.", quiet
      ? [finding("low-dynamics", quiet, .72, "Review this quiet region for unintended dropouts; adjust mix gain only within this time range.")] : []);
  base.artifactsAndDistortion = available(Math.max(0, 1 - clipped.length / windows.length * 4),
    "Peak and discontinuity proxies were measured from rendered PCM.", clipped.slice(0, 3)
      .map((window) => finding("possible-clipping", window, .95, "Reduce gain or limiter drive in this local mix region.")));
  base.transitions = available(jump ? .62 : .94, "Adjacent fixed-window energy changes were measured from rendered PCM.",
    jump ? [finding("abrupt-transition", jump, .78, "Smooth the local transition with bounded automation or an edit crossfade.")] : []);
  base.repetition = available(repeated ? .68 : .91, "Repeated fixed-window loudness and texture proxies were compared.",
    repeated ? [finding("repetitive-texture", repeated, .61, "Consider a local orchestration or mix variation in this region.")] : []);
  const usable = dimensions.filter((name) => base[name].status === "available");
  // A provider-supplied full mix cannot honestly expose per-track masking or
  // balance evidence. Release sufficiency therefore rests on the four
  // artifact-bound master dimensions; stem-dependent dimensions remain
  // explicitly unavailable instead of turning honest abstention into failure.
  const requiredMasterDimensions: CandidateAudioCriticDimension[] = [
    "dynamics",
    "artifactsAndDistortion",
    "transitions",
    "repetition",
  ];
  const sufficient = requiredMasterDimensions.every((name) => base[name].status === "available");
  const score = sufficient ? usable.reduce((sum, name) => sum + (base[name].score ?? 0), 0) / usable.length : null;
  return { version: analyzerVersion, status: sufficient ? "available" : "insufficient", score,
    coverage: { availableDimensions: usable.length, totalDimensions: 7, sufficient },
    evidence: { artifactId: input.artifactId, artifactSha256: input.artifactSha256, sampleRate: input.sampleRate, analyzerVersion },
    dimensions: base };
}

export { dimensions as perceptualAudioCriticDimensions };