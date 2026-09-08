import { useState, useRef, useEffect, useCallback } from "react";
import { useRoute } from "wouter";
import {
  useGetProject,
  useListArrangements,
  useCreateArrangement,
  useGenerateArrangement,
  useGetGenerationJob,
  useListGenerationCandidates,
  useListGenerationProviders,
  getListGenerationProvidersQueryKey,
  useSelectGenerationCandidate,
  useRepairGenerationCandidate,
  useUpdateArrangement,
  useListTracks,
  useListArtifacts,
  useListProjectSources,
  useRunCopilot,
  useCreateProjectExport,
  useCreateProducerDecision,
  useGetProducerPreferences,
  useUpdateProducerPreferences,
  useListMixMasterRevisions,
  useCreateMixMasterRevision,
  useApproveMixMasterRevision,
  getListMixMasterRevisionsQueryKey,
  useGetProductionJob,
  getGetProductionJobQueryKey,
  useGetProjectSongModel,
  getGetProjectSongModelQueryKey,
  getListArtifactsQueryKey,
  getListTracksQueryKey,
  getGetGenerationJobQueryKey,
  getListGenerationCandidatesQueryKey,
  getGetProducerPreferencesQueryKey,
  getListProducerDecisionsQueryKey,
  ExportResult,
  GenerationCandidate,
  HarmonyDecisionEvidence,
  ArrangementMode,
  Arrangement,
  ArrangementSection,
  ProducerDecisionInput
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetProjectQueryKey, getListArrangementsQueryKey } from "@workspace/api-client-react";
import {
  Wand2,
  SlidersHorizontal,
  Bot,
  Activity,
  Layers,
  Sparkles,
  ChevronRight,
  ListMusic,
  Check,
  Plus,
  Download,
  FileArchive,
  Loader2,
  Grid3X3,
  ShieldCheck,
  Wrench,
  Play,
  Pause,
} from "lucide-react";

import { EmptyState } from "@/components/ui/empty";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { SourceImport } from "@/components/studio/source-import";
import { SongModelInspector } from "@/components/studio/song-model-inspector";
import { ArrangerEditor } from "@/components/studio/arranger-editor";
import {
  AudioTransportControls,
  AudioTransportStatus,
} from "@/components/studio/audio-transport";
import { useAudioTransport } from "@/components/studio/use-audio-transport";
import { getCandidatePlaybackPresentation } from "@/components/studio/candidate-playback";
import { EditorConflictError } from "@/components/studio/editor-save-coordinator";
import type { CopilotEditorResult, EditorSelection } from "@/components/studio/editor-types";
import {
  isRepairEligible,
  repairLineageLabel,
  repairOutcomeTitle,
  retainedRepairSourceForJob,
  resolveRepairSourceCandidate,
  type RepairFindingPreview,
} from "./project-workspace-repair";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ExportRenderEvidence, type RenderEvidence } from "@/components/studio/export-render-evidence";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
function readHarmonyDecisions(value: unknown): HarmonyDecisionEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.filter((decision): decision is HarmonyDecisionEvidence =>
    Boolean(decision) &&
    typeof decision === "object" &&
    typeof (decision as { start?: unknown }).start === "number" &&
    Number.isFinite((decision as { start: number }).start) &&
    typeof (decision as { end?: unknown }).end === "number" &&
    Number.isFinite((decision as { end: number }).end) &&
    typeof (decision as { symbol?: unknown }).symbol === "string" &&
    ["song_model_chord_evidence", "deterministic_candidate_scoring"].includes(
      String((decision as { source?: unknown }).source),
    ));
}
export default function ProjectWorkspace() {
  const [, params] = useRoute("/projects/:projectId");
  const projectId = params?.projectId || "";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();

  const { data: workspace, isLoading, error } = useGetProject(projectId);
  const { data: songModel } = useGetProjectSongModel(projectId, {
    query: {
      queryKey: getGetProjectSongModelQueryKey(projectId),
      enabled: workspace?.project.status === "ready",
      retry: false,
    },
  });
  const { data: arrangements } = useListArrangements(projectId);
  const { data: tracks } = useListTracks(projectId);
  const { data: artifacts } = useListArtifacts(projectId);
  const { data: sources } = useListProjectSources(projectId);
  const { data: generationProviders } = useListGenerationProviders({
    query: {
      queryKey: getListGenerationProvidersQueryKey(),
      refetchInterval: 30_000,
      staleTime: 10_000,
    },
  });

  const createArrangement = useCreateArrangement();
  const updateArrangement = useUpdateArrangement();
  const generateArrangement = useGenerateArrangement();
  const selectGenerationCandidate = useSelectGenerationCandidate();
  const repairGenerationCandidate = useRepairGenerationCandidate();
  const createExport = useCreateProjectExport();
  const createProducerDecision = useCreateProducerDecision();
  const producerPreferencesQuery = useGetProducerPreferences({
    query: { queryKey: getGetProducerPreferencesQueryKey(), staleTime: 5_000 },
  });
  const updateProducerPreferences = useUpdateProducerPreferences();
  const { data: mixMasterRevisions } = useListMixMasterRevisions(projectId, {
    query: { queryKey: getListMixMasterRevisionsQueryKey(projectId), staleTime: 5_000 },
  });
  const createMixMasterRevision = useCreateMixMasterRevision();
  const approveMixMasterRevision = useApproveMixMasterRevision();

  const [activeTab, setActiveTab] = useState("editor");
  const [revisionPreviewing, setRevisionPreviewing] = useState(false);
  const [selectedArrangementId, setSelectedArrangementId] = useState<string | null>(null);
  const [generationJobId, setGenerationJobId] = useState<string | null>(null);
  const [aceOperation, setAceOperation] = useState<
    "COMPLETE" | "LEGO" | "REPAINT" | "COVER" | "EXTRACT"
  >("COMPLETE");
  const [aceSourceArtifactId, setAceSourceArtifactId] = useState("");
  const [aceInstrument, setAceInstrument] = useState("drums");
  const [repaintStartBar, setRepaintStartBar] = useState(1);
  const [repaintEndBar, setRepaintEndBar] = useState(2);
  const [candidatePreview, setCandidatePreview] = useState<{
    id: string;
    label: string;
    url: string;
  } | null>(null);
  const [repairPreview, setRepairPreview] = useState<RepairFindingPreview | null>(null);
  const [repairSourceCandidate, setRepairSourceCandidate] = useState<GenerationCandidate | null>(null);
  const [repairSourceJobId, setRepairSourceJobId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [includeStems, setIncludeStems] = useState(true);
  const [includeMidi, setIncludeMidi] = useState(true);
  const [masterProfile, setMasterProfile] = useState("STREAMING");
  const [masterLufs, setMasterLufs] = useState(-14);
  const [truePeakDbtp, setTruePeakDbtp] = useState(-1);
  const [limiter, setLimiter] = useState(true);
  const [stereoWidth, setStereoWidth] = useState(1);
  type LocalTrackMix = { levelDb: number; pan: number; bus: "MIX" | "DRUMS" | "MUSIC" | "VOCALS" | "FX"; sendDb: number; processing: { highPassHz: number; compressorRatio: number; saturation: number } };
  const [selectedMixTrackId, setSelectedMixTrackId] = useState("");
  const [trackMixControls, setTrackMixControls] = useState<Record<string, LocalTrackMix>>({});
  useEffect(() => {
    if (!tracks?.length) return;
    setSelectedMixTrackId((current) => current || tracks[0].id);
    setTrackMixControls((current) => Object.fromEntries(tracks.map((track) => [track.id, current[track.id] ?? {
      levelDb: track.volume, pan: 0, bus: "MIX" as const, sendDb: -80,
      processing: { highPassHz: 20, compressorRatio: 1, saturation: 0 },
    }])));
  }, [tracks]);
  const selectedTrackMix = trackMixControls[selectedMixTrackId];
  const updateSelectedTrackMix = (update: (control: LocalTrackMix) => LocalTrackMix) =>
    setTrackMixControls((current) => selectedMixTrackId && current[selectedMixTrackId]
      ? { ...current, [selectedMixTrackId]: update(current[selectedMixTrackId]) } : current);
  const [selectedMixControl, setSelectedMixControl] = useState<string | null>(null);
  const [auditionRevisionId, setAuditionRevisionId] = useState<string | null>(null);
  const [auditionVariant, setAuditionVariant] = useState<"original" | "repaired" | "mixed" | "mastered">("mastered");
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const [candidateRatings, setCandidateRatings] = useState<Record<string, number>>({});
  const [candidateReasons, setCandidateReasons] = useState<Record<string, string>>({});
  const [comparisonCandidateId, setComparisonCandidateId] = useState("");
  const [preferenceSaveError, setPreferenceSaveError] = useState<string | null>(null);
  const { data: exportJob } = useGetProductionJob(exportJobId ?? "", {
    query: {
      enabled: Boolean(exportJobId),
      queryKey: getGetProductionJobQueryKey(exportJobId ?? ""),
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "queued" || status === "running" || status === "cancel_requested" ? 1500 : false;
      },
    },
  });
  const latestReadyExport = [...(artifacts ?? [])]
    .filter((artifact) => artifact.type === "EXPORT" && artifact.state === "ready")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  const evidenceExportId = exportResult?.id ?? latestReadyExport?.id;
  const exportEvidence: RenderEvidence[] = (artifacts ?? [])
    .filter((artifact) =>
      artifact.type === "STEM" &&
      artifact.technicalMetadata.exportId === evidenceExportId &&
      (artifact.technicalMetadata.rendererStatus === "licensed-native" ||
        artifact.technicalMetadata.rendererStatus === "deterministic-fallback"),
    )
    .map((artifact) => {
      const metadata = artifact.technicalMetadata;
      const text = (key: string) =>
        typeof metadata[key] === "string" ? metadata[key] as string : undefined;
      return {
        trackName: text("trackName") ?? artifact.label,
        role: text("role") ?? "stem",
        rendererStatus: metadata.rendererStatus as RenderEvidence["rendererStatus"],
        rendererProvider: text("rendererProvider"),
        rendererProduct: text("rendererProduct"),
        nativeHost: text("nativeHost"),
        licenseOwner: text("licenseOwner"),
        licenseReference: text("licenseReference"),
        assetSha256: text("assetSha256"),
        rendererSha256: text("rendererSha256"),
        smokeOutputSha256: text("smokeOutputSha256"),
        trackModelSha256: text("trackModelSha256"),
        rendererOutputSha256: text("rendererOutputSha256"),
        stemOutputSha256: text("stemOutputSha256"),
        fallbackReason: text("fallbackReason"),
      };
    });

  const [copilotCommand, setCopilotCommand] = useState("");
  const [editorSelection, setEditorSelection] = useState<EditorSelection>(null);
  const [copilotEditorResult, setCopilotEditorResult] = useState<CopilotEditorResult | null>(null);
  const [mobilePanel, setMobilePanel] = useState<"tracks" | "copilot" | null>(null);
  useEffect(() => {
    if (!isMobile) setMobilePanel(null);
  }, [isMobile]);
  const currentSource =
    sources?.find((source) => source.id === songModel?.sourceId)
    ?? sources?.[0];
  const playbackUnavailableReason = candidatePreview
    ? null
    : !currentSource
    ? "Import audio to enable playback"
    : currentSource.status !== "ready"
      ? "Audio is still being prepared"
      : currentSource.sourceType === "MIDI" || currentSource.contentType === "audio/midi"
        ? "MIDI has no audio; export a preview to listen"
        : null;
  const sourceReady = playbackUnavailableReason === null;
  const durationHint =
    currentSource?.durationSeconds
    ?? songModel?.audio?.durationSeconds
    ?? parseDuration(workspace?.project.duration);
  const auditionRevision = mixMasterRevisions?.find((revision) => revision.id === auditionRevisionId);
  const auditionVariantUrl = auditionRevision?.variants[auditionVariant]?.url ?? null;
  const transport = useAudioTransport(
    auditionVariantUrl ?? auditionRevision?.previewUrl ?? candidatePreview?.url ??
      (sourceReady && currentSource
        ? `/api/projects/${projectId}/playback?sourceId=${encodeURIComponent(currentSource.id)}`
        : null),
    durationHint,
  );
  const handleCandidatePlayback = useCallback((candidate: GenerationCandidate) => {
    const audio = candidate.evaluation.artifacts.find(
      (artifact) => artifact.type === "AUDIO_TRACK",
    );
    if (!audio) return;
    if (candidatePreview?.id === candidate.id) {
      transport.toggle();
      return;
    }
    setCandidatePreview({
      id: candidate.id,
      label: candidate.label,
      url: audio.url,
    });
  }, [candidatePreview?.id, transport]);
  useEffect(() => {
    if (!candidatePreview) return;
    void transport.play();
  }, [candidatePreview?.id, candidatePreview?.url, transport.play]);
  const runCopilot = useRunCopilot();
  const [copilotMessages, setCopilotMessages] = useState<Array<{
    role: 'user'|'assistant';
    text: string;
    operations?: any[];
    interpreter?: "openai" | "deterministic";
  }>>([
    { role: 'assistant', text: "Hi! I'm your studio assistant. I can help analyze the track, tweak arrangement parameters, or suggest structural changes. What would you like to do?" }
  ]);

  // Sync selected arrangement
  useEffect(() => {
    if (arrangements?.length && !selectedArrangementId) {
      setSelectedArrangementId(arrangements[0].id);
    }
  }, [arrangements, selectedArrangementId]);

  const activeArrangement = arrangements?.find(a => a.id === selectedArrangementId);
  const playbackBeatsPerBar = Number(workspace?.analysis?.meter?.split("/")[0]) || 4;
  const playbackBpm = workspace?.project.bpm || workspace?.analysis?.bpm || 120;
  const playbackDuration = transport.duration || durationHint;
  const durationBarCount = playbackDuration > 0
    ? Math.max(1, Math.ceil(playbackDuration / ((60 / playbackBpm) * playbackBeatsPerBar)))
    : 1;
  const arrangementBarCount = Math.max(
    durationBarCount,
    ...(activeArrangement?.sections.map((section, index) => section.endBar ?? ((index + 1) * 8)) ?? [1]),
  );
  const currentPlaybackBar = playbackDuration > 0
    ? 1 + Math.min(1, transport.currentTime / playbackDuration) * (arrangementBarCount - 1)
    : 1;
  const handleEditorSectionsChange = useCallback(async (sections: ArrangementSection[]) => {
    if (!activeArrangement) return;
    try {
      const updated = await updateArrangement.mutateAsync({
        arrangementId: activeArrangement.id,
        data: { sections, expectedVersion: activeArrangement.version },
      });
      queryClient.setQueryData(
        getListArrangementsQueryKey(projectId),
        (current: typeof arrangements | undefined) =>
          current?.map((arrangement) => arrangement.id === updated.id ? updated : arrangement),
      );
    } catch (saveError) {
      if (
        saveError
        && typeof saveError === "object"
        && "status" in saveError
        && saveError.status === 409
      ) {
        await queryClient.refetchQueries({ queryKey: getListArrangementsQueryKey(projectId) });
        toast({
          title: "Arrangement changed elsewhere",
          description: "Choose whether to load the latest revision or apply your local edit.",
          variant: "destructive",
        });
        throw new EditorConflictError();
      }
      toast({
        title: "Local edit could not be saved",
        description: saveError instanceof Error ? saveError.message : "Review the edit and try again.",
        variant: "destructive",
      });
      throw saveError;
    }
  }, [activeArrangement, arrangements, projectId, queryClient, toast, updateArrangement]);
  const requestedGenerationTask =
    activeArrangement?.mode === "PRO_SCORE" ? "ORCHESTRATION" : "ARRANGEMENT";
  const requestedGenerationSpeed =
    activeArrangement?.mode === "QUICK_ARRANGE"
      ? "FAST"
      : activeArrangement?.mode === "PRO_SCORE"
        ? "QUALITY"
        : "BALANCED";
  const compatibleArrangementProviders = generationProviders?.filter(
    (provider) =>
      provider.tasks.includes(requestedGenerationTask) &&
      provider.speeds.includes(requestedGenerationSpeed) &&
      (
        activeArrangement?.mode === "PRO_SCORE" ||
        provider.id === "ACE_STEP"
      ),
  );
  const availableArrangementProviders = compatibleArrangementProviders?.filter(
    (provider) => provider.status === "ready" && provider.available,
  );
  const generationJobQuery = useGetGenerationJob(generationJobId ?? "", {
    query: {
      queryKey: getGetGenerationJobQueryKey(generationJobId ?? ""),
      enabled: Boolean(generationJobId),
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "queued" || status === "running" ? 1_000 : false;
      },
    },
  });
  const generationJob = generationJobQuery.data;
  const generationCandidatesQuery = useListGenerationCandidates(
    generationJobId ?? "",
    {
      query: {
        queryKey: getListGenerationCandidatesQueryKey(generationJobId ?? ""),
        enabled: Boolean(generationJobId) && generationJob?.status === "succeeded",
      },
    },
  );
  const generationCandidates = generationCandidatesQuery.data ?? [];
  const repairSourceCandidatesQuery = useListGenerationCandidates(
    repairSourceJobId ?? "",
    {
      query: {
        queryKey: getListGenerationCandidatesQueryKey(repairSourceJobId ?? ""),
        enabled: Boolean(repairSourceJobId),
      },
    },
  );
  const persistedRepairSourceCandidate = resolveRepairSourceCandidate(
    repairSourceCandidate,
    repairSourceCandidatesQuery.data,
    generationCandidates,
  );
  const visibleGenerationCandidates =
    persistedRepairSourceCandidate &&
    !generationCandidates.some((candidate) => candidate.id === persistedRepairSourceCandidate.id)
      ? [persistedRepairSourceCandidate, ...generationCandidates]
      : generationCandidates;
  const activeHarmonyDecisions = generationCandidates.find(
    (candidate) => candidate.id === activeArrangement?.sourceCandidateId,
  )?.harmonyDecisions ?? readHarmonyDecisions(
    activeArrangement?.generationProvenance?.parameters?.["harmonyDecisions"],
  );
  const generationRunning =
    generateArrangement.isPending ||
    generationJob?.status === "queued" ||
    generationJob?.status === "running";
  const handledTerminalJobRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeArrangement) {
      setGenerationJobId(null);
      return;
    }
    setGenerationJobId(
      window.sessionStorage.getItem(
        `music-studio:generation-job:${activeArrangement.id}`,
      ),
    );
    setRepairSourceJobId(
      window.sessionStorage.getItem(
        `music-studio:repair-source-job:${activeArrangement.id}`,
      ),
    );
  }, [activeArrangement?.id]);

  useEffect(() => {
    if (!generationJob || handledTerminalJobRef.current === generationJob.id) return;
    if (generationJob.status === "succeeded") {
      handledTerminalJobRef.current = generationJob.id;
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      queryClient.invalidateQueries({ queryKey: getListArrangementsQueryKey(projectId) });
      queryClient.invalidateQueries({ queryKey: getListArtifactsQueryKey(projectId) });
      toast({
        title: "Candidates ready",
        description: `${generationJob.provider} returned ranked arrangement candidates.`,
      });
    } else if (generationJob.status === "failed") {
      handledTerminalJobRef.current = generationJob.id;
      queryClient.invalidateQueries({ queryKey: getListArrangementsQueryKey(projectId) });
      toast({
        title: "Generation failed",
        description: generationJob.error ?? "The provider worker could not finish this job.",
        variant: "destructive",
      });
    }
  }, [generationJob, projectId, queryClient, toast]);

  // Auto-save logic for arrangement parameters
  const [localHarmony, setLocalHarmony] = useState<number>(5);
  const [localEnergy, setLocalEnergy] = useState<number>(0.5);
  const [localDensity, setLocalDensity] = useState<number>(0.5);
  const [localOrchestraSize, setLocalOrchestraSize] = useState<number>(0.5);
  const [localRhythmIntensity, setLocalRhythmIntensity] = useState<number>(0.5);

  const initializedArrangementRef = useRef<string | null>(null);

  useEffect(() => {
    const revisionKey = activeArrangement
      ? `${activeArrangement.id}:${activeArrangement.version}`
      : null;
    if (activeArrangement && initializedArrangementRef.current !== revisionKey) {
      initializedArrangementRef.current = revisionKey;
      setLocalHarmony(activeArrangement.harmonyComplexity);
      setLocalEnergy(activeArrangement.energy);
      setLocalDensity(activeArrangement.density);
      setLocalOrchestraSize(activeArrangement.orchestraSize ?? 0.5);
      setLocalRhythmIntensity(activeArrangement.rhythmIntensity ?? 0.5);
    }
  }, [activeArrangement]);

  const handleParamChange = (param: string, value: number) => {
    if (revisionPreviewing) return;
    if (param === 'harmony') setLocalHarmony(value);
    if (param === 'energy') setLocalEnergy(value);
    if (param === 'density') setLocalDensity(value);
    if (param === 'orchestraSize') setLocalOrchestraSize(value);
    if (param === 'rhythmIntensity') setLocalRhythmIntensity(value);
  };

  const commitParamChange = (param: string, value: number) => {
    if (!activeArrangement || revisionPreviewing) return;

    const paramKeyMap: Record<string, keyof Pick<Arrangement, 'harmonyComplexity' | 'energy' | 'density' | 'orchestraSize' | 'rhythmIntensity'>> = {
      harmony: 'harmonyComplexity',
      energy: 'energy',
      density: 'density',
      orchestraSize: 'orchestraSize',
      rhythmIntensity: 'rhythmIntensity'
    };

    const key = paramKeyMap[param];
    if (!key) return;

    updateArrangement.mutate({
      arrangementId: activeArrangement.id,
      data: {
        [key]: value,
        expectedVersion: activeArrangement.version,
      }
    }, {
      onSuccess: (updated) => {
        queryClient.setQueryData(
          getListArrangementsQueryKey(projectId),
          (current: typeof arrangements | undefined) =>
            current?.map((arrangement) => arrangement.id === updated.id ? updated : arrangement),
        );
      },
      onError: async (paramError) => {
        if (
          paramError
          && typeof paramError === "object"
          && "status" in paramError
          && paramError.status === 409
        ) {
          await queryClient.refetchQueries({ queryKey: getListArrangementsQueryKey(projectId) });
          toast({
            title: "Arrangement changed elsewhere",
            description: "The latest conductor values were loaded. Review the control and try again.",
            variant: "destructive",
          });
          return;
        }
        toast({
          title: "Conductor change could not be saved",
          description: paramError instanceof Error ? paramError.message : "Try the change again.",
          variant: "destructive",
        });
      },
    });
  };

  const handleGenerate = () => {
    if (!activeArrangement) return;
    const sourceArtifactId = aceSourceArtifactId || undefined;
    generateArrangement.mutate({
      arrangementId: activeArrangement.id,
      data: {
        candidates: 3,
        task: requestedGenerationTask,
        hardware: "AUTO",
        speed: requestedGenerationSpeed,
        ...(activeArrangement.mode === "PRO_SCORE"
          ? {}
          : {
              provider: "ACE_STEP" as const,
              operation: aceOperation,
              ...(sourceArtifactId ? { sourceArtifactId } : {}),
              ...(["LEGO", "EXTRACT"].includes(aceOperation)
                ? { instrument: aceInstrument }
                : {}),
              ...(aceOperation === "REPAINT"
                ? {
                    region: {
                      unit: "bar" as const,
                      start: repaintStartBar,
                      end: repaintEndBar,
                      crossfadeSeconds: 0.25,
                    },
                  }
                : {}),
            }),
      }
    }, {
      onSuccess: (job) => {
        setGenerationJobId(job.id);
        setCandidatePreview(null);
        setRepairSourceCandidate(null);
        setRepairSourceJobId(null);
        window.sessionStorage.setItem(
          `music-studio:generation-job:${activeArrangement.id}`,
          job.id,
        );
        window.sessionStorage.removeItem(
          `music-studio:repair-source-job:${activeArrangement.id}`,
        );
        handledTerminalJobRef.current = null;
        setActiveTab("candidates");
        toast({
          title: "Generation queued",
          description: `${job.provider} is preparing ${job.requestedCandidates} candidates.`,
        });
        queryClient.invalidateQueries({ queryKey: getListArrangementsQueryKey(projectId) });
      },
      onError: (error) => {
        const failure = generationFailure(error);
        toast({
          title: failure.title,
          description: failure.description,
          variant: "destructive",
        });
      }
    });
  };

  const handleSelectCandidate = (candidate: GenerationCandidate) => {
    selectGenerationCandidate.mutate(
      { candidateId: candidate.id },
      {
        onSuccess: (arrangement) => {
          setSelectedArrangementId(arrangement.id);
          setActiveTab("arrangement");
          queryClient.invalidateQueries({
            queryKey: getListArrangementsQueryKey(projectId),
          });
          queryClient.invalidateQueries({
            queryKey: getGetProjectQueryKey(projectId),
          });
          queryClient.invalidateQueries({
            queryKey: getListTracksQueryKey(projectId),
          });
          if (generationJobId) {
            queryClient.invalidateQueries({
              queryKey: getListGenerationCandidatesQueryKey(generationJobId),
            });
          }
          toast({
            title: "Candidate selected",
            description: `${candidate.label} is now arrangement v${arrangement.version}.`,
          });
        },
        onError: () => {
          toast({
            title: "Candidate could not be selected",
            description: "Only validated provider candidates can become arrangements.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const boundedReasons = (value: string) => {
    const reason = value.trim().slice(0, 500);
    return reason ? [reason] : undefined;
  };

  const submitProducerDecision = useCallback((
    decision: Omit<ProducerDecisionInput, "projectId">,
    successMessage: string,
  ) => {
    createProducerDecision.mutate(
      { data: { projectId, ...decision } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getListProducerDecisionsQueryKey() });
          toast({ title: "Producer preference saved", description: successMessage });
        },
        onError: (decisionError) => {
          toast({
            title: "Producer preference could not be saved",
            description: decisionError instanceof Error ? decisionError.message : "Try again.",
            variant: "destructive",
          });
        },
      },
    );
  }, [createProducerDecision.mutate, projectId, queryClient, toast]);

  const handleEditorDecision = useCallback((
    decision: { kind: "edit" | "restore"; subjectId: string; reason: string },
  ) => {
    submitProducerDecision(
      {
        domain: "arrangement",
        kind: decision.kind,
        subjectId: decision.subjectId,
        reasons: [decision.reason.slice(0, 500)],
      },
      decision.kind === "restore" ? "Arrangement restoration recorded privately." : "Arrangement edit recorded privately.",
    );
  }, [submitProducerDecision]);

  const saveProducerPreferences = (updates: Partial<{
    learningEnabled: boolean;
    inferredBehaviorEnabled: boolean;
  }>) => {
    const current = producerPreferencesQuery.data;
    if (!current) return;
    setPreferenceSaveError(null);
    updateProducerPreferences.mutate(
      { data: { ...current, ...updates } },
      {
        onSuccess: (preferences) => {
          queryClient.setQueryData(getGetProducerPreferencesQueryKey(), preferences);
          void queryClient.invalidateQueries({ queryKey: getGetProducerPreferencesQueryKey() });
          toast({ title: "Private preferences saved", description: "Your controls will be restored when you return." });
        },
        onError: (preferencesError) => {
          setPreferenceSaveError(
            preferencesError instanceof Error ? preferencesError.message : "Could not save private preferences.",
          );
        },
      },
    );
  };

  const retainedRepairSource = retainedRepairSourceForJob(
    generationJob?.status,
    generationCandidates.length,
    persistedRepairSourceCandidate,
  );

  const renderRetainedRepairSourceCard = () => {
    if (!retainedRepairSource) return null;
    const candidate = retainedRepairSource;
    const evaluated = Boolean(
      candidate.evaluation.qualityReport && candidate.evaluation.musicCritic,
    );
    const hasAudio = candidate.evaluation.artifacts.some(
      (artifact) => artifact.type === "AUDIO_TRACK",
    );
    const active = candidatePreview?.id === candidate.id;
    const playing = active && transport.status === "playing";
    return (
      <Card data-testid="retained-repair-source" className="border-primary/30">
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-semibold">{candidate.label}</div>
              <Badge variant="outline">Original · repair source</Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{candidate.summary}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              This original candidate remains available and unchanged.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant={active ? "secondary" : "outline"}
              disabled={!hasAudio || (active && transport.status === "loading")}
              onClick={() => handleCandidatePlayback(candidate)}
            >
              {playing ? (
                <Pause className="mr-2 h-4 w-4" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              {playing ? "Pause" : "Preview"}
            </Button>
            <Button
              size="sm"
              disabled={
                candidate.status !== "validated" ||
                !evaluated ||
                selectGenerationCandidate.isPending ||
                candidate.evaluation.diversity?.rejected
              }
              onClick={() => handleSelectCandidate(candidate)}
            >
              {candidate.status === "selected" ? "Selected" : "Select"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  const handleRepairCandidate = () => {
    if (!repairPreview || !activeArrangement) return;
    const sourceCandidate = repairPreview.candidate;
    repairGenerationCandidate.mutate(
      {
        candidateId: sourceCandidate.id,
        data: {
          idempotencyKey: crypto.randomUUID(),
          findingId: repairPreview.finding.id,
          finding: repairPreview.finding,
        },
      },
      {
        onSuccess: (job) => {
          setRepairSourceCandidate(sourceCandidate);
          setRepairSourceJobId(sourceCandidate.jobId);
          setGenerationJobId(job.id);
          setRepairPreview(null);
          handledTerminalJobRef.current = null;
          window.sessionStorage.setItem(
            `music-studio:generation-job:${activeArrangement.id}`,
            job.id,
          );
          window.sessionStorage.setItem(
            `music-studio:repair-source-job:${activeArrangement.id}`,
            sourceCandidate.jobId,
          );
          toast({
            title: "Critic repair queued",
            description: `${sourceCandidate.label} stays available while the bounded repair is evaluated.`,
          });
        },
        onError: (repairError) => {
          toast({
            title: "Repair could not be queued",
            description: repairError instanceof Error
              ? repairError.message
              : "The critic finding was not accepted.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const downloadFile = (url: string) => {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const handleExport = () => {
    if (!activeArrangement) return;
    const approved = mixMasterRevisions?.find((revision) =>
      revision.arrangementId === activeArrangement.id && revision.approvedAt);
    if (!approved) {
      toast({ title: "Approval required", description: "Approve a rendered mix/master revision before exporting.", variant: "destructive" });
      return;
    }
    setExportResult(null);
    createExport.mutate({
      projectId,
      data: {
        idempotencyKey: crypto.randomUUID(),
        arrangementId: activeArrangement.id,
        approvedRevisionId: approved.id,
        includeStems,
        includeMidi,
        includeMix: true,
        includeMetadata: true,
        masterProfile: masterProfile as "STREAMING" | "DYNAMIC" | "CLASSICAL" | "POP" | "LOUD" | "FILM",
      },
    }, {
      onSuccess: (result) => {
        setExportJobId(result.id);
        toast({
          title: "Export queued",
          description: "Rendering continues in the background. This dialog will download it when ready.",
        });
      },
      onError: () => {
        toast({
          title: "Export failed",
          description: "The render could not be completed. Please try again.",
          variant: "destructive",
        });
      },
    });
  };

  useEffect(() => {
    if (!exportJob || exportJob.status !== "succeeded" || exportResult) return;
    const exportId = exportJob.outputArtifactIds[0];
    if (!exportId) return;
    const bundleUrl = `/api/exports/${exportId}/download`;
    setExportResult({
      id: exportId, status: "ready", files: [], bundleUrl, createdAt: exportJob.createdAt,
    });
    queryClient.invalidateQueries({ queryKey: getListArtifactsQueryKey(projectId) });
    toast({ title: "Export package ready", description: "Your rendered export is ready to download." });
    downloadFile(bundleUrl);
  }, [exportJob, exportResult, projectId, queryClient, toast]);

  const handleCreateArrangement = () => {
    createArrangement.mutate({
      projectId,
      data: {
        name: `Version ${arrangements ? arrangements.length + 1 : 1}`,
        style: "Modern Electronic",
        harmonyComplexity: 5,
        mode: "STUDIO" as ArrangementMode
      }
    }, {
      onSuccess: (newArr) => {
        setSelectedArrangementId(newArr.id);
        toast({ title: "Arrangement Created" });
        queryClient.invalidateQueries({ queryKey: getListArrangementsQueryKey(projectId) });
      }
    });
  };

  const handleCopilotSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!copilotCommand.trim() || runCopilot.isPending || revisionPreviewing) return;

    const command = copilotCommand;
    setCopilotMessages(prev => [...prev, { role: 'user', text: command }]);
    setCopilotCommand("");

    runCopilot.mutate({
      projectId,
      data: {
        command,
        arrangementId: activeArrangement?.id,
        targetSection: editorSelection?.sectionName,
        targetTrack: editorSelection && "trackName" in editorSelection ? editorSelection.trackName : undefined,
        startBar: editorSelection?.startBar,
        endBar: editorSelection?.endBar,
      }
    }, {
      onSuccess: (res) => {
        setCopilotMessages(prev => [...prev, {
          role: 'assistant',
          text: res.reply,
           operations: res.operations,
           interpreter: res.interpreter,
        }]);
        setCopilotEditorResult(res);
        // Also refresh arrangement / project data just in case copilot changed something!
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getListArrangementsQueryKey(projectId) });
      },
      onError: () => {
        toast({ title: "Copilot Error", description: "Failed to process command", variant: "destructive" });
      }
    });
  };

  const renderTracksPanel = () => (
    <>
      <div className="h-12 shrink-0 border-b flex items-center px-4 justify-between bg-sidebar-accent/30 font-semibold text-sm">
        <div className="flex items-center gap-2">
          <ListMusic className="h-4 w-4 text-primary" />
          Tracks
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full"><Plus className="h-3.5 w-3.5" /></Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {tracks?.map(track => (
            <div key={track.id} className="flex flex-col p-2 rounded-md hover:bg-sidebar-accent/50 group text-sm border border-transparent hover:border-sidebar-border transition-all">
              <div className="flex items-center gap-3 w-full">
                <div className="w-2 h-2 rounded-full shrink-0 shadow-sm" style={{ backgroundColor: track.color || 'hsl(var(--primary))' }} />
                <div className="flex-1 truncate font-medium">{track.name}</div>
                <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity gap-1">
                  <button className={cn("h-5 w-5 rounded flex items-center justify-center text-[10px] font-bold border", track.muted ? "bg-red-500/10 text-red-500 border-red-500/20" : "bg-muted text-muted-foreground hover:bg-background")}>M</button>
                  <button className={cn("h-5 w-5 rounded flex items-center justify-center text-[10px] font-bold border", track.solo ? "bg-yellow-500/10 text-yellow-600 border-yellow-500/20" : "bg-muted text-muted-foreground hover:bg-background")}>S</button>
                </div>
              </div>
              <div className="flex gap-2 pl-5 mt-1 opacity-60 text-[10px] uppercase font-semibold">
                <span>{track.role}</span>
                <span>•</span>
                <span>{track.kind}</span>
                <span>•</span>
                <span className={track.status === 'rendered' ? "text-emerald-500" : ""}>{track.status}</span>
              </div>
            </div>
          ))}
          {!tracks?.length && (
            <div className="text-center p-4 text-xs text-muted-foreground italic">No tracks generated yet.</div>
          )}
        </div>
      </ScrollArea>
    </>
  );

  const renderCopilotPanel = () => (
    <>
      <div className="h-12 shrink-0 border-b flex items-center px-4 gap-2 font-semibold text-sm bg-muted/10">
        <Bot className="h-4 w-4 text-primary" />
        Studio Copilot
      </div>

      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4 text-sm">
          {copilotMessages.map((msg, i) => (
            <div key={i} className={cn("p-3 rounded-lg", msg.role === 'assistant' ? "bg-muted rounded-tl-none" : "bg-primary text-primary-foreground rounded-tr-none ml-6")}>
              <p className={msg.operations?.length ? "mb-2" : ""}>{msg.text}</p>
              {msg.role === "assistant" && msg.interpreter && (
                <Badge
                  variant="outline"
                  className={cn(
                    "mb-2 h-5 text-[10px]",
                    msg.interpreter === "openai"
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-700"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-700",
                  )}
                >
                  {msg.interpreter === "openai" ? "AI interpreted" : (
                    <><ShieldCheck className="mr-1 h-3 w-3" />Safe local fallback</>
                  )}
                </Badge>
              )}
              {msg.operations && msg.operations.length > 0 && (
                <div className="bg-background text-foreground rounded border p-2 text-xs font-mono space-y-1">
                  {msg.operations.map((op, j) => (
                    <div key={j} className="flex justify-between">
                      <span>{op.type}</span> <span className="text-primary">{op.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {runCopilot.isPending && (
            <div className="bg-muted p-3 rounded-lg rounded-tl-none animate-pulse">
              Thinking...
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="p-3 border-t bg-background">
        {editorSelection && (
          <div className="mb-2 flex items-center justify-between rounded-md border border-primary/20 bg-primary/5 px-2 py-1.5 text-[10px]">
            <span className="min-w-0 truncate">
              Target: {editorSelection.sectionName}
              {"trackName" in editorSelection ? ` · ${editorSelection.trackName}` : ""}
              {editorSelection.startBar ? ` · bars ${editorSelection.startBar}–${editorSelection.endBar}` : ""}
            </span>
            <button type="button" className="ml-2 text-muted-foreground hover:text-foreground" onClick={() => setEditorSelection(null)}>Clear</button>
          </div>
        )}
        <form className="flex gap-2" onSubmit={handleCopilotSubmit}>
          <Input
            placeholder="Ask copilot..."
            className="text-sm shadow-sm"
            value={copilotCommand}
            onChange={(e) => setCopilotCommand(e.target.value)}
            disabled={runCopilot.isPending || revisionPreviewing}
          />
          <Button type="submit" size="icon" className="shrink-0" disabled={!copilotCommand.trim() || runCopilot.isPending || revisionPreviewing}>
            <Bot className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </>
  );

  if (isLoading) {
    return <div className="p-10 flex items-center justify-center min-h-screen text-muted-foreground"><Activity className="animate-pulse mr-2" /> Loading workspace...</div>;
  }

  if (error || !workspace) {
    return <div className="p-10 text-destructive text-center font-bold">Project not found or error loading workspace.</div>;
  }

  const { project, analysis } = workspace;

  return (
    <div className="flex flex-col h-full bg-background relative overflow-hidden">
      {/* Top Header / Transport */}
      <header className="min-h-16 h-auto border-b bg-card flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 shadow-sm z-10 relative md:px-6">
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <h1 className="text-lg font-bold text-foreground leading-tight flex items-center gap-2">
              {project.name}
              <Badge variant="outline" className="font-mono text-xs py-0 h-5 bg-muted">{project.status}</Badge>
            </h1>
          </div>
        </div>

        {/* Global stats */}
        <div className="hidden md:flex items-center gap-6 bg-muted/30 px-6 py-1.5 rounded-full border shadow-inner text-sm font-mono text-foreground font-medium">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs uppercase">BPM</span>
            {project.bpm || analysis?.bpm || "--"}
          </div>
          <div className="w-1 h-1 rounded-full bg-border" />
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs uppercase">Key</span>
            {project.key || analysis?.key || "--"}
          </div>
          <div className="w-1 h-1 rounded-full bg-border" />
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs uppercase">Time</span>
            {analysis?.meter || "—"}
          </div>
        </div>

        <div className="order-3 flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 md:order-none md:w-auto md:flex-nowrap">
          <AudioTransportControls transport={transport} compact />
          <div className="min-w-0 max-w-[120px] flex-1 shrink overflow-hidden sm:max-w-48 sm:flex-none">
            {candidatePreview ? (
              <div className="flex min-w-0 items-center gap-1">
                <span
                  className="truncate text-[11px] text-primary"
                  title={`Candidate preview: ${candidatePreview.label}`}
                >
                  Candidate: {candidatePreview.label}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-1.5 text-[10px]"
                  onClick={() => setCandidatePreview(null)}
                >
                  Source
                </Button>
              </div>
            ) : (
              <AudioTransportStatus transport={transport} unavailableReason={playbackUnavailableReason} />
            )}
          </div>
          {activeArrangement && (
            <div
              data-testid="transport-mobile-bar-readout"
              className="basis-full pl-[76px] font-mono text-[10px] tabular-nums text-muted-foreground md:hidden"
              aria-label="Current arrangement bar"
            >
              Bar {Math.floor(currentPlaybackBar)} / {arrangementBarCount}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <SourceImport
            projectId={projectId}
            sourceType={project.sourceType}
            onReady={() => {
              void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
              void queryClient.invalidateQueries({ queryKey: getGetProjectSongModelQueryKey(projectId) });
              void queryClient.invalidateQueries({ queryKey: getListArtifactsQueryKey(projectId) });
              void queryClient.invalidateQueries({ queryKey: getGetProjectSongModelQueryKey(projectId) });
            }}
          />
          <Button variant="outline" size="sm" className="font-mono text-xs hidden sm:flex">
            <Layers className="h-3.5 w-3.5 mr-1.5" />
            Artifacts ({artifacts?.length ?? workspace.artifacts?.length ?? 0})
          </Button>
          <Button
            size="sm"
            className="shadow-sm shadow-primary/20"
            onClick={() => setExportOpen(true)}
            disabled={!activeArrangement || !tracks?.length}
          >
            Export <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
        <div className="order-4 flex w-full gap-2 md:hidden">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 justify-center gap-1.5 bg-background"
            onClick={() => setMobilePanel("tracks")}
            aria-label="Open Tracks"
          >
            <ListMusic className="h-4 w-4 text-primary" />
            Tracks
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 justify-center gap-1.5 bg-background"
            onClick={() => setMobilePanel("copilot")}
            aria-label="Open Studio Copilot"
          >
            <Bot className="h-4 w-4 text-primary" />
            Copilot
          </Button>
        </div>
      </header>

      {/* Main Workspace Area */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Left Panel: Tracks */}
        <aside className="hidden w-64 border-r bg-sidebar flex-col shrink-0 z-10 shadow-[2px_0_10px_rgba(0,0,0,0.02)] md:flex">
          {renderTracksPanel()}
        </aside>

        {/* Center Panel: Arrangement & Timeline */}
        <main className="flex-1 flex flex-col min-w-0 bg-background z-0 relative">
          {/* Analysis Timeline Strip */}
          <div className="h-44 border-b bg-card p-4 shrink-0 flex flex-col relative overflow-hidden">
            <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, black 1px, transparent 0)', backgroundSize: '16px 16px' }} />
            <div className="flex items-center justify-between mb-2 relative z-10">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5" />
                Structure Map
              </h3>
              {songModel && (
                <span className="font-mono text-[10px] text-muted-foreground">
                  Song Model v{songModel.version}
                </span>
              )}
            </div>

            {songModel?.waveform?.length ? (
              <div
                className="mb-2 flex h-10 items-center gap-px rounded border bg-muted/20 px-2"
                aria-label="Measured source waveform"
              >
                {songModel.waveform.map((peak, index) => (
                  <span
                    key={index}
                    className="min-w-px flex-1 rounded-full bg-primary/65"
                    style={{ height: `${Math.max(8, peak * 100)}%` }}
                  />
                ))}
              </div>
            ) : null}

            <div className="flex-1 bg-muted/30 rounded-md border flex items-stretch p-1 gap-1 relative z-10">
              {analysis?.sections?.length ? analysis.sections.map((section, idx) => (
                <div
                  key={idx}
                  className="relative rounded-[4px] border flex flex-col justify-between p-1.5 overflow-hidden group cursor-pointer hover:border-primary/50 transition-colors"
                  style={{ flex: section.endBar - section.startBar, backgroundColor: `hsl(var(--primary) / ${0.05 + (section.energy * 0.2)})` }}
                >
                  <div className="text-[10px] font-bold truncate text-foreground/80">{section.name}</div>
                  <div className="text-[9px] font-mono text-muted-foreground">{section.startBar}-{section.endBar}</div>
                  {/* Energy bar */}
                  <div className="absolute bottom-0 left-0 right-0 h-1 bg-primary/20">
                    <div className="h-full bg-primary" style={{ width: `${section.energy * 100}%` }} />
                  </div>
                </div>
              )) : (
                <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground italic">
                  Run analysis to generate structure map
                </div>
              )}
            </div>
          </div>

          <Tabs
            value={activeTab}
            onValueChange={(value) => {
              if (!revisionPreviewing || value === "editor") setActiveTab(value);
            }}
            className="flex-1 flex flex-col min-h-0"
          >
            <div className="px-6 pt-4 shrink-0">
              <TabsList className="grid w-full max-w-2xl grid-cols-4">
                <TabsTrigger value="editor">Editor</TabsTrigger>
                <TabsTrigger value="model" data-testid="tab-model" disabled={revisionPreviewing}>Song Model</TabsTrigger>
                <TabsTrigger value="arrangement" data-testid="tab-director" disabled={revisionPreviewing}>Director</TabsTrigger>
                <TabsTrigger value="candidates" data-testid="tab-candidates" disabled={revisionPreviewing}>Candidates</TabsTrigger>
                <TabsTrigger value="mix-master" data-testid="tab-mix-master" disabled={!activeArrangement || revisionPreviewing}>Mix & master</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="editor" className="flex-1 min-h-0 flex flex-col overflow-hidden relative m-0 p-4">
              {activeArrangement ? (
                <ArrangerEditor
                  projectId={projectId}
                  arrangement={activeArrangement}
                  analysis={analysis}
                  songModel={songModel}
                  harmonyDecisions={activeHarmonyDecisions}
                  tracks={tracks ?? []}
                  copilotResult={copilotEditorResult}
                  onSelectionChange={setEditorSelection}
                  onSectionsChange={handleEditorSectionsChange}
                  onExplicitDecision={handleEditorDecision}
                  onRevisionPreviewChange={setRevisionPreviewing}
                  playheadSeconds={transport.currentTime}
                  timelineDurationSeconds={transport.duration || durationHint}
                  onSeek={transport.seek}
                />
              ) : (
                <EmptyState
                  icon={Grid3X3}
                  title="Create an arrangement to start editing"
                  description="The timeline keeps every chord, MIDI note, automation point, and semantic direction inside a versioned arrangement."
                  action={<Button onClick={handleCreateArrangement}>Create Arrangement</Button>}
                />
              )}
            </TabsContent>

            <TabsContent value="model" className="flex-1 min-h-0 overflow-auto m-0 p-6">
              <div className="max-w-4xl mx-auto h-full">
                <SongModelInspector projectId={projectId} />
              </div>
            </TabsContent>

            <TabsContent value="arrangement" className="flex-1 min-h-0 overflow-auto m-0 p-6">
              <div className="max-w-3xl mx-auto space-y-6">

                {/* Arrangement Selector */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Select value={selectedArrangementId || ""} onValueChange={setSelectedArrangementId}>
                      <SelectTrigger className="w-[240px] font-medium bg-card">
                        <SelectValue placeholder="Select arrangement" />
                      </SelectTrigger>
                      <SelectContent>
                        {arrangements?.map(arr => (
                          <SelectItem key={arr.id} value={arr.id}>{arr.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="outline" size="icon" onClick={handleCreateArrangement}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  {activeArrangement && (
                    <Badge variant={activeArrangement.status === 'generating' ? 'secondary' : 'outline'} className="font-mono bg-card shadow-sm">
                      {activeArrangement.status}
                    </Badge>
                  )}
                </div>

                {activeArrangement ? (
                  <div className="space-y-6">
                    <Card className="shadow-sm border-t-2 border-t-primary">
                      <CardHeader className="pb-4">
                        <CardTitle className="text-lg flex items-center gap-2">
                          <SlidersHorizontal className="h-5 w-5 text-primary" />
                          Creative Parameters
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-8">
                        <div className="space-y-4">
                          <div className="flex justify-between items-center">
                            <Label className="text-sm font-semibold">Harmony Complexity</Label>
                            <span className="font-mono text-xs bg-muted px-2 py-1 rounded">{localHarmony}/10</span>
                          </div>
                          <Slider
                            value={[localHarmony]}
                            min={1} max={10} step={1}
                            onValueChange={([v]) => handleParamChange('harmony', v)}
                            onValueCommit={([v]) => commitParamChange('harmony', v)}
                          />
                          <p className="text-xs text-muted-foreground">Controls chord extensions, voicing density, and progression movement.</p>
                        </div>

                        <div className="space-y-4">
                          <div className="flex justify-between items-center">
                            <Label className="text-sm font-semibold">Energy Level</Label>
                            <span className="font-mono text-xs bg-muted px-2 py-1 rounded">{Math.round(localEnergy * 100)}%</span>
                          </div>
                          <Slider
                            value={[localEnergy]}
                            min={0} max={1} step={0.05}
                            onValueChange={([v]) => handleParamChange('energy', v)}
                            onValueCommit={([v]) => commitParamChange('energy', v)}
                          />
                          <p className="text-xs text-muted-foreground">Overall intensity, dynamic range, and high-frequency presence.</p>
                        </div>

                        <div className="space-y-4">
                          <div className="flex justify-between items-center">
                            <Label className="text-sm font-semibold">Instrumentation Density</Label>
                            <span className="font-mono text-xs bg-muted px-2 py-1 rounded">{Math.round(localDensity * 100)}%</span>
                          </div>
                          <Slider
                            value={[localDensity]}
                            min={0} max={1} step={0.05}
                            onValueChange={([v]) => handleParamChange('density', v)}
                            onValueCommit={([v]) => commitParamChange('density', v)}
                          />
                          <p className="text-xs text-muted-foreground">Number of simultaneous parts and textural thickness.</p>
                        </div>

                        <div className="space-y-4">
                          <div className="flex justify-between items-center">
                            <Label className="text-sm font-semibold">Orchestra Size</Label>
                            <span className="font-mono text-xs bg-muted px-2 py-1 rounded">{Math.round(localOrchestraSize * 100)}%</span>
                          </div>
                          <Slider
                            value={[localOrchestraSize]}
                            min={0} max={1} step={0.05}
                            onValueChange={([v]) => handleParamChange('orchestraSize', v)}
                            onValueCommit={([v]) => commitParamChange('orchestraSize', v)}
                          />
                          <p className="text-xs text-muted-foreground">Scale of the arrangement from intimate solo to full symphony.</p>
                        </div>

                        <div className="space-y-4">
                          <div className="flex justify-between items-center">
                            <Label className="text-sm font-semibold">Rhythm Intensity</Label>
                            <span className="font-mono text-xs bg-muted px-2 py-1 rounded">{Math.round(localRhythmIntensity * 100)}%</span>
                          </div>
                          <Slider
                            value={[localRhythmIntensity]}
                            min={0} max={1} step={0.05}
                            onValueChange={([v]) => handleParamChange('rhythmIntensity', v)}
                            onValueCommit={([v]) => commitParamChange('rhythmIntensity', v)}
                          />
                          <p className="text-xs text-muted-foreground">Complexity and drive of the underlying rhythmic foundation.</p>
                        </div>
                      </CardContent>
                    </Card>

                    <Card className="shadow-sm">
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <ShieldCheck className="h-4 w-4 text-primary" />
                          Private producer preferences
                        </CardTitle>
                        <p className="text-xs text-muted-foreground">
                          These controls are private to your producer profile. Arrangement complexity and dynamics remain explicit project controls above.
                        </p>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {producerPreferencesQuery.isLoading ? (
                          <div data-testid="status-producer-preferences-loading" className="text-sm text-muted-foreground">Loading private preferences…</div>
                        ) : producerPreferencesQuery.error ? (
                          <Alert variant="destructive">
                            <AlertTitle>Private preferences unavailable</AlertTitle>
                            <AlertDescription>Reload to try retrieving your producer controls again.</AlertDescription>
                          </Alert>
                        ) : producerPreferencesQuery.data ? (
                          <>
                            <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
                              <div>
                                <Label htmlFor="learning-enabled" className="font-medium">Enable preference learning</Label>
                                <p className="text-xs text-muted-foreground">Allow your explicit feedback to inform future assistance.</p>
                              </div>
                              <Checkbox
                                id="learning-enabled"
                                data-testid="checkbox-learning-enabled"
                                checked={producerPreferencesQuery.data.learningEnabled}
                                disabled={updateProducerPreferences.isPending}
                                onCheckedChange={(checked) => saveProducerPreferences({ learningEnabled: checked === true })}
                              />
                            </div>
                            <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
                              <div>
                                <Label htmlFor="inferred-behavior-enabled" className="font-medium">Include inferred behavior</Label>
                                <p className="text-xs text-muted-foreground">Permit behavior-derived signals alongside your explicit feedback.</p>
                              </div>
                              <Checkbox
                                id="inferred-behavior-enabled"
                                data-testid="checkbox-inferred-behavior-enabled"
                                checked={producerPreferencesQuery.data.inferredBehaviorEnabled}
                                disabled={updateProducerPreferences.isPending}
                                onCheckedChange={(checked) => saveProducerPreferences({ inferredBehaviorEnabled: checked === true })}
                              />
                            </div>
                            <div data-testid="status-producer-preferences" className="text-xs text-muted-foreground">
                              {updateProducerPreferences.isPending
                                ? "Saving private preferences…"
                                : `Saved ${new Date(producerPreferencesQuery.data.updatedAt).toLocaleString()}`}
                            </div>
                            {preferenceSaveError && (
                              <Alert variant="destructive">
                                <AlertTitle>Private preferences could not be saved</AlertTitle>
                                <AlertDescription>{preferenceSaveError}</AlertDescription>
                              </Alert>
                            )}
                          </>
                        ) : null}
                      </CardContent>
                    </Card>

                    <Card className="shadow-sm">
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <Activity className="h-4 w-4 text-primary" />
                          Generation runtimes
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {compatibleArrangementProviders?.map((provider) => {
                          const ready = provider.status === "ready";
                          const configured = provider.status === "configured";
                          const provenance = provider.runtimeProvenance;
                          const label = ready
                            ? "Ready"
                            : configured
                              ? "Configured · unhealthy"
                              : "Unavailable";
                          return (
                            <div
                              key={provider.id}
                              className="flex items-start justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2"
                            >
                              <div className="min-w-0">
                                <div className="text-sm font-medium">
                                  {provider.name}
                                </div>
                                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                  {provider.reportedVersion ?? provider.modelVersion}
                                  {" · "}
                                  {provider.lastHealth.message}
                                </div>
                                {provenance && (
                                  <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                                    <div>
                                      <span className="font-medium text-foreground">Image</span>
                                      {" "}
                                      <span className="font-mono">{provenance.modalImageId}</span>
                                    </div>
                                    <div className="break-all">
                                      <span className="font-medium text-foreground">Checkpoint</span>
                                      {" "}
                                      <span className="font-mono">{provenance.checkpointSha256}</span>
                                    </div>
                                    <div className="break-all">
                                      <span className="font-medium text-foreground">Source</span>
                                      {" "}
                                      <span className="font-mono">{provenance.sourceImageDigest}</span>
                                    </div>
                                    <div>
                                      CUDA {provenance.cudaVersion}
                                      {" · "}
                                      PyTorch {provenance.pytorchVersion}
                                      {" · "}
                                      {provenance.gpu}
                                      {" · "}
                                      {provider.smokeTested ? "Smoke passed" : "Smoke not verified"}
                                    </div>
                                  </div>
                                )}
                              </div>
                              <Badge
                                variant={ready ? "default" : configured ? "destructive" : "outline"}
                                className={cn(
                                  "shrink-0",
                                  ready && "bg-emerald-600 hover:bg-emerald-600",
                                  !configured && !ready && "text-muted-foreground",
                                )}
                              >
                                {label}
                              </Badge>
                            </div>
                          );
                        })}
                      </CardContent>
                    </Card>

                    {activeArrangement.mode !== "PRO_SCORE" && (
                      <Card>
                        <CardContent className="grid gap-4 p-4 md:grid-cols-2">
                          <label className="space-y-1 text-sm font-medium">
                            ACE-Step operation
                            <select
                              className="mt-1 h-10 w-full rounded-md border bg-background px-3"
                              value={aceOperation}
                              onChange={(event) => setAceOperation(event.target.value as typeof aceOperation)}
                            >
                              {["COMPLETE", "LEGO", "REPAINT", "COVER", "EXTRACT"].map((operation) => (
                                <option key={operation} value={operation}>{operation}</option>
                              ))}
                            </select>
                          </label>
                          <label className="space-y-1 text-sm font-medium">
                            Source audio
                            <select
                              className="mt-1 h-10 w-full rounded-md border bg-background px-3"
                              value={aceSourceArtifactId}
                              onChange={(event) => setAceSourceArtifactId(event.target.value)}
                            >
                              <option value="">Use latest project audio</option>
                              {(artifacts ?? [])
                                .filter((artifact) =>
                                  ["SOURCE", "NORMALIZED_AUDIO", "STEM", "AUDIO_TRACK"].includes(artifact.type))
                                .map((artifact) => (
                                  <option key={artifact.id} value={artifact.id}>
                                    {artifact.type} · {artifact.id.slice(0, 8)}
                                  </option>
                                ))}
                            </select>
                          </label>
                          {["LEGO", "EXTRACT"].includes(aceOperation) && (
                            <label className="space-y-1 text-sm font-medium">
                              Focused instrument
                              <select
                                className="mt-1 h-10 w-full rounded-md border bg-background px-3"
                                value={aceInstrument}
                                onChange={(event) => setAceInstrument(event.target.value)}
                              >
                                {["drums", "bass", "guitar", "piano", "strings", "brass", "woodwinds", "synth", "vocals"].map((instrument) => (
                                  <option key={instrument} value={instrument}>{instrument}</option>
                                ))}
                              </select>
                            </label>
                          )}
                          {aceOperation === "REPAINT" && (
                            <div className="grid grid-cols-2 gap-3">
                              <label className="space-y-1 text-sm font-medium">
                                Start bar
                                <input
                                  type="number"
                                  min={1}
                                  className="mt-1 h-10 w-full rounded-md border bg-background px-3"
                                  value={repaintStartBar}
                                  onChange={(event) => setRepaintStartBar(Number(event.target.value))}
                                />
                              </label>
                              <label className="space-y-1 text-sm font-medium">
                                End bar
                                <input
                                  type="number"
                                  min={repaintStartBar + 1}
                                  className="mt-1 h-10 w-full rounded-md border bg-background px-3"
                                  value={repaintEndBar}
                                  onChange={(event) => setRepaintEndBar(Number(event.target.value))}
                                />
                              </label>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    )}
                    <div className="flex justify-end">
                      <Button
                        size="lg"
                        onClick={handleGenerate}
                        disabled={
                          generationRunning ||
                          availableArrangementProviders?.length === 0
                        }
                        className="shadow-md shadow-primary/20 text-md px-8"
                      >
                        {generationRunning ? (
                          <><Activity className="mr-2 h-5 w-5 animate-pulse" /> Generating...</>
                        ) : (
                          <><Wand2 className="mr-2 h-5 w-5" /> Generate Variations</>
                        )}
                      </Button>
                    </div>
                    {availableArrangementProviders?.length === 0 && (
                      <Alert>
                        <Activity className="h-4 w-4" />
                        <AlertTitle>No verified generation runtime is ready</AlertTitle>
                        <AlertDescription>
                          {compatibleArrangementProviders?.some(
                            (provider) => provider.status === "configured",
                          )
                            ? "A worker is configured, but its checkpoint or runtime health check failed. Restore the worker before generating."
                            : "Connect an ACE-Step, AnyAccomp, SymphonyGen, or METEOR worker to generate real candidates."}
                          {" "}The studio will not substitute fabricated output.
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                ) : (
                  <EmptyState
                    icon={SlidersHorizontal}
                    title="No Arrangement Selected"
                    description="Create an arrangement to direct the generation."
                    action={<Button onClick={handleCreateArrangement}>Create Arrangement</Button>}
                  />
                )}
              </div>
            </TabsContent>

            <TabsContent value="mix-master" className="flex-1 m-0 p-6 min-h-0 overflow-auto">
              <div className="mx-auto max-w-4xl space-y-5">
                <Card>
                  <CardHeader>
                    <CardTitle>Audition revision</CardTitle>
                    <p className="text-sm text-muted-foreground">Create immutable WAV previews from the current arrangement. All versions share the project’s canonical timeline.</p>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    <div><Label>Track</Label><Select value={selectedMixTrackId} onValueChange={setSelectedMixTrackId}><SelectTrigger><SelectValue placeholder="Select track" /></SelectTrigger><SelectContent>{(tracks ?? []).map((track) => <SelectItem key={track.id} value={track.id}>{track.name}</SelectItem>)}</SelectContent></Select></div>
                    {selectedTrackMix && <>
                    <div className="grid gap-4 md:grid-cols-3">
                      <div className={cn(selectedMixControl?.endsWith(".levelDb") && "rounded border-2 border-amber-500 p-2")}><Label>Track level {selectedTrackMix.levelDb.toFixed(1)} dB</Label><Slider min={-60} max={12} step={0.5} value={[selectedTrackMix.levelDb]} onValueChange={([value]) => updateSelectedTrackMix((control) => ({ ...control, levelDb: value }))} /></div>
                      <div className={cn(selectedMixControl === "master.targetLufs" && "rounded border-2 border-amber-500 p-2")}><Label>Master target {masterLufs} LUFS</Label><Slider min={-24} max={-6} step={1} value={[masterLufs]} onValueChange={([value]) => setMasterLufs(value)} /></div>
                      <div className={cn(selectedMixControl === "master.truePeakDbtp" && "rounded border-2 border-amber-500 p-2")}><Label>True peak {truePeakDbtp.toFixed(1)} dBTP</Label><Slider min={-6} max={-0.1} step={0.1} value={[truePeakDbtp]} onValueChange={([value]) => setTruePeakDbtp(value)} /></div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-3">
                      <div><Label>Pan {selectedTrackMix.pan.toFixed(2)}</Label><Slider min={-1} max={1} step={.05} value={[selectedTrackMix.pan]} onValueChange={([value]) => updateSelectedTrackMix((control) => ({ ...control, pan: value }))} /></div>
                      <div><Label>Send {selectedTrackMix.sendDb} dB</Label><Slider min={-80} max={6} step={1} value={[selectedTrackMix.sendDb]} onValueChange={([value]) => updateSelectedTrackMix((control) => ({ ...control, sendDb: value }))} /></div>
                      <div><Label>Bus</Label><Select value={selectedTrackMix.bus} onValueChange={(value) => updateSelectedTrackMix((control) => ({ ...control, bus: value as LocalTrackMix["bus"] }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["MIX","DRUMS","MUSIC","VOCALS","FX"].map((bus) => <SelectItem key={bus} value={bus}>{bus}</SelectItem>)}</SelectContent></Select></div>
                      <div><Label>HPF {selectedTrackMix.processing.highPassHz} Hz</Label><Slider min={20} max={20000} step={10} value={[selectedTrackMix.processing.highPassHz]} onValueChange={([value]) => updateSelectedTrackMix((control) => ({ ...control, processing: { ...control.processing, highPassHz: value } }))} /></div>
                      <div><Label>Compressor {selectedTrackMix.processing.compressorRatio.toFixed(1)}:1</Label><Slider min={1} max={20} step={.5} value={[selectedTrackMix.processing.compressorRatio]} onValueChange={([value]) => updateSelectedTrackMix((control) => ({ ...control, processing: { ...control.processing, compressorRatio: value } }))} /></div>
                      <div><Label>Saturation {selectedTrackMix.processing.saturation.toFixed(2)}</Label><Slider min={0} max={1} step={.05} value={[selectedTrackMix.processing.saturation]} onValueChange={([value]) => updateSelectedTrackMix((control) => ({ ...control, processing: { ...control.processing, saturation: value } }))} /></div>
                      <div><Label>Stereo width {stereoWidth.toFixed(2)}</Label><Slider min={0} max={2} step={.05} value={[stereoWidth]} onValueChange={([value]) => setStereoWidth(value)} /></div>
                      <div className="flex items-center gap-2 pt-5"><Checkbox checked={limiter} onCheckedChange={(checked) => setLimiter(checked === true)} /><Label>Master limiter</Label></div>
                    </div>
                    </>}
                    <Button disabled={!activeArrangement || createMixMasterRevision.isPending} onClick={() => {
                      if (!activeArrangement) return;
                      const controlledTracks = trackMixControls;
                      createMixMasterRevision.mutate({ projectId, data: {
                        arrangementId: activeArrangement.id, tracks: controlledTracks,
                        master: { targetLufs: masterLufs, truePeakDbtp, processing: { limiter, stereoWidth } },
                      } }, { onSuccess: (revision) => {
                        setAuditionRevisionId(revision.id);
                        void queryClient.invalidateQueries({ queryKey: getListMixMasterRevisionsQueryKey(projectId) });
                        toast({ title: "WAV audition rendered", description: `Revision v${revision.version} is ready for A/B audition.` });
                      }, onError: () => toast({ title: "Audition render failed", description: "The immutable revision could not be rendered.", variant: "destructive" }) });
                    }}>
                      {createMixMasterRevision.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}Render audition
                    </Button>
                  </CardContent>
                </Card>
                <div className="space-y-3">
                  {(mixMasterRevisions ?? []).filter((revision) => revision.arrangementId === activeArrangement?.id).map((revision) => (
                    <Card key={revision.id} className={cn(auditionRevisionId === revision.id && "border-primary")}>
                      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div><div className="font-medium">Mix/master v{revision.version} {revision.approvedAt ? "· Approved" : ""}</div>
                          <p className="text-xs text-muted-foreground">Timeline {revision.evidence.timelineSha256.slice(0, 12)} · {revision.evidence.quality.integratedLufs} LUFS · {revision.evidence.quality.truePeakDbtp} dBTP</p>
                          {revision.evidence.quality.findings.map((finding) => <button key={finding.id} className="block text-left text-xs text-amber-600 hover:underline" onClick={() => { setAuditionRevisionId(revision.id); setSelectedMixControl(finding.control); const match = /^tracks\\.([^.]+)\\./.exec(finding.control); if (match) setSelectedMixTrackId(match[1]); transport.seek(finding.startSeconds); }}>{finding.message} → {finding.control}</button>)}
                        </div>
                        <div className="flex flex-wrap gap-2">{(["original", "repaired", "mixed", "mastered"] as const).map((variant) => <Button key={variant} size="sm" variant={auditionRevisionId === revision.id && auditionVariant === variant ? "secondary" : "outline"} disabled={!revision.variants[variant]} onClick={() => { setAuditionRevisionId(revision.id); setAuditionVariant(variant); }}>{variant}</Button>)}
                          <Button size="sm" disabled={Boolean(revision.approvedAt) || approveMixMasterRevision.isPending} onClick={() => approveMixMasterRevision.mutate({ projectId, revisionId: revision.id }, { onSuccess: () => { void queryClient.invalidateQueries({ queryKey: getListMixMasterRevisionsQueryKey(projectId) }); toast({ title: "Revision approved", description: "Exports now use this exact approved master WAV." }); } })}>Approve</Button></div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="candidates" className="flex-1 m-0 p-6 min-h-0 overflow-auto">
               <div className="max-w-3xl mx-auto">
                 <h2 className="text-xl font-bold mb-6">Generated Candidates</h2>
                  {generationJob && generationRunning ? (
                    <div className="space-y-4">
                    <Card>
                      <CardContent className="space-y-4 p-6">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className="font-semibold">
                              {generationJob.stage.replaceAll("_", " ")}
                            </div>
                            <div className="mt-1 text-sm text-muted-foreground">
                              {generationJob.provider} · {generationJob.modelVersion}
                            </div>
                          </div>
                          <Badge variant="secondary">{generationJob.progress}%</Badge>
                        </div>
                        <Progress value={generationJob.progress} />
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span>{generationJob.hardware} hardware</span>
                          <span>{generationJob.speed.toLowerCase()} routing</span>
                        </div>
                      </CardContent>
                    </Card>
                    {renderRetainedRepairSourceCard()}
                    </div>
                  ) : generationJob?.status === "failed" &&
                    generationCandidates.length === 0 ? (
                    <div className="space-y-4">
                      <Alert variant="destructive">
                        <Activity className="h-4 w-4" />
                        <AlertTitle>Provider generation failed</AlertTitle>
                        <AlertDescription>
                          {generationJob.error ?? "The worker returned an unknown error."}
                        </AlertDescription>
                      </Alert>
                      {renderRetainedRepairSourceCard()}
                    </div>
                  ) : (generationJob?.status === "succeeded" ||
                    generationJob?.status === "failed") &&
                    generationCandidates.length > 0 ? (
                   <div className="space-y-4">
                      {visibleGenerationCandidates.map((candidate: GenerationCandidate) => {
                        const quality = candidate.evaluation.qualityReport;
                         const critic = candidate.evaluation.musicCritic;
                          const evaluated = quality && critic;
                          const repair = candidate.evaluation.repair;
                          const isRepairSource = persistedRepairSourceCandidate?.id === candidate.id;
                        return (
                          <Card key={candidate.id} className="group hover:border-primary/50 transition-colors shadow-sm">
                            <CardContent className="p-4 space-y-4">
                              <div className="flex items-start justify-between gap-4">
                                <div className="flex items-start gap-4">
                                  <div className={cn(
                                    "h-11 w-11 shrink-0 rounded-full flex flex-col items-center justify-center font-mono text-xs font-bold",
                                    evaluated
                                      ? "bg-primary/10 text-primary"
                                      : "bg-destructive/10 text-destructive",
                                  )}>
                                    <span>{critic ? Math.round(critic.score * 100) : "—"}</span>
                                    <span className="text-[8px] font-sans font-medium uppercase">fit</span>
                                  </div>
                                  <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <div className="font-semibold">{candidate.label}</div>
                                      <Badge variant={candidate.rank === 1 && evaluated && !candidate.evaluation.diversity?.rejected ? "default" : "outline"}>
                                        {candidate.rank === null ? "Unranked" : `#${candidate.rank}`}
                                      </Badge>
                                      <Badge variant={evaluated ? "secondary" : "destructive"}>
                                        {candidate.evaluation.status.replaceAll("_", " ")}
                                      </Badge>
                                      {candidate.evaluation.strategy && (
                                        <Badge variant="outline" className="capitalize">
                                          {candidate.evaluation.strategy.name}
                                        </Badge>
                                      )}
                                      {candidate.evaluation.diversity && (
                                        <Badge variant={candidate.evaluation.diversity.rejected ? "secondary" : "outline"} className="capitalize">
                                          {candidate.evaluation.diversity.rejected ? "Rejected" : "Accepted"}: {candidate.evaluation.diversity.reason.replaceAll("_", " ")}
                                        </Badge>
                                      )}
                                      {isRepairSource && (
                                        <Badge variant="outline">Original · repair source</Badge>
                                      )}
                                      {repair && (
                                        <Badge variant={repair.improved ? "default" : "secondary"}>
                                          {repairLineageLabel(
                                            repair.sourceCandidateId,
                                             repair.sourceCandidateLabel,
                                            persistedRepairSourceCandidate,
                                          )}
                                        </Badge>
                                      )}
                                    </div>
                                    <div className="mt-1 text-xs text-muted-foreground">
                                      {candidate.provider} · {candidate.modelVersion} · provider score {Math.round(candidate.evaluation.providerScore * 100)}
                                    </div>
                                    <p className="mt-2 max-w-xl text-sm">{candidate.summary}</p>
                                    <div className="mt-2 text-xs text-muted-foreground">
                                      {candidate.plan.sections.length} sections · {Math.round(candidate.confidence * 100)}% confidence · {candidate.evaluation.strategy?.seed ? `derived seed ${candidate.evaluation.strategy.seed}` : `seed ${candidate.seed}`}
                                    </div>
                                  </div>
                                </div>
                                <div className="flex shrink-0 flex-col gap-2 sm:flex-row items-center sm:items-start">
                                  {(() => {
                                    const audio = candidate.evaluation.artifacts.find(
                                      (artifact) => artifact.type === "AUDIO_TRACK",
                                    );
                                     const playback = getCandidatePlaybackPresentation({
                                       candidateId: candidate.id,
                                       candidateLabel: candidate.label,
                                       activeCandidateId: candidatePreview?.id ?? null,
                                       hasAudio: Boolean(audio),
                                       transportStatus: transport.status,
                                     });
                                    return (
                                  <Button
                                    size="sm"
                                     variant={playback.active ? "secondary" : "outline"}
                                     disabled={playback.disabled}
                                     aria-label={playback.label}
                                    onClick={() => handleCandidatePlayback(candidate)}
                                  >
                                     {playback.playing ? (
                                      <Pause className="mr-2 h-4 w-4" />
                                    ) : (
                                      <Play className="mr-2 h-4 w-4" />
                                    )}
                                     {playback.text}
                                  </Button>
                                    );
                                  })()}
                                  <div className="flex flex-col items-center gap-1">
                                    <span title={candidate.evaluation.diversity?.rejected ? `Rejected: ${candidate.evaluation.diversity.reason.replaceAll("_", " ")}` : undefined}>
                                      <Button
                                        size="sm"
                                        disabled={
                                          candidate.status !== "validated" ||
                                          !evaluated ||
                                          selectGenerationCandidate.isPending ||
                                          candidate.evaluation.diversity?.rejected
                                        }
                                        onClick={() => handleSelectCandidate(candidate)}
                                      >
                                        {candidate.status === "selected" ? "Selected" : "Select"}
                                      </Button>
                                    </span>
                                    {candidate.evaluation.diversity?.rejected && (
                                      <span className="text-[10px] text-muted-foreground max-w-[80px] text-center leading-tight">
                                        Omitted for diversity
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                              <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div>
                                    <div className="text-xs font-semibold text-foreground">Producer preference <span className="font-normal text-muted-foreground">· private explicit feedback</span></div>
                                    <p className="text-[10px] text-muted-foreground">Your judgment is recorded separately from the Music Critic evidence below.</p>
                                  </div>
                                  <Badge variant="outline">Not critic evidence</Badge>
                                </div>
                                <div className="mt-3 grid gap-2 sm:grid-cols-[150px_1fr]">
                                  <Select
                                    value={String(candidateRatings[candidate.id] ?? 3)}
                                    onValueChange={(value) => setCandidateRatings((current) => ({ ...current, [candidate.id]: Number(value) }))}
                                  >
                                    <SelectTrigger data-testid={`select-producer-rating-${candidate.id}`}>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {[1, 2, 3, 4, 5].map((rating) => <SelectItem key={rating} value={String(rating)}>{rating} / 5</SelectItem>)}
                                    </SelectContent>
                                  </Select>
                                  <Input
                                    data-testid={`input-producer-reason-${candidate.id}`}
                                    value={candidateReasons[candidate.id] ?? ""}
                                    maxLength={500}
                                    placeholder="Optional reason (up to 500 characters)"
                                    onChange={(event) => setCandidateReasons((current) => ({ ...current, [candidate.id]: event.target.value }))}
                                  />
                                </div>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    data-testid={`button-rate-candidate-${candidate.id}`}
                                    disabled={createProducerDecision.isPending}
                                    onClick={() => submitProducerDecision({
                                      domain: "candidate",
                                      kind: "rating",
                                      subjectId: candidate.id,
                                      rating: candidateRatings[candidate.id] ?? 3,
                                      reasons: boundedReasons(candidateReasons[candidate.id] ?? ""),
                                    }, `${candidate.label} rated privately.`)}
                                  >
                                    Save rating
                                  </Button>
                                  <Button
                                    size="sm"
                                    data-testid={`button-approve-candidate-${candidate.id}`}
                                    disabled={createProducerDecision.isPending}
                                    onClick={() => submitProducerDecision({
                                      domain: "candidate",
                                      kind: "approval",
                                      subjectId: candidate.id,
                                      reasons: boundedReasons(candidateReasons[candidate.id] ?? ""),
                                    }, `${candidate.label} approved privately.`)}
                                  >
                                    Approve
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    data-testid={`button-reject-candidate-${candidate.id}`}
                                    disabled={createProducerDecision.isPending}
                                    onClick={() => submitProducerDecision({
                                      domain: "candidate",
                                      kind: "rejection",
                                      subjectId: candidate.id,
                                      reasons: boundedReasons(candidateReasons[candidate.id] ?? ""),
                                    }, `${candidate.label} rejected privately.`)}
                                  >
                                    Reject
                                  </Button>
                                </div>
                                <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
                                  <Select value={comparisonCandidateId || undefined} onValueChange={setComparisonCandidateId}>
                                    <SelectTrigger data-testid={`select-comparison-candidate-${candidate.id}`} className="w-full sm:w-[220px]">
                                      <SelectValue placeholder="Compare against candidate…" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {visibleGenerationCandidates.filter((other) => other.id !== candidate.id).map((other) => (
                                        <SelectItem key={other.id} value={other.id}>{other.label}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    data-testid={`button-compare-candidate-${candidate.id}`}
                                    disabled={!comparisonCandidateId || createProducerDecision.isPending}
                                    onClick={() => submitProducerDecision({
                                      domain: "candidate",
                                      kind: "comparison",
                                      subjectId: candidate.id,
                                      comparedSubjectId: comparisonCandidateId,
                                      reasons: boundedReasons(candidateReasons[candidate.id] ?? ""),
                                    }, `${candidate.label} marked as preferred in this private comparison.`)}
                                  >
                                    Prefer this candidate
                                  </Button>
                                </div>
                                {createProducerDecision.isPending && (
                                  <p data-testid={`status-producer-decision-${candidate.id}`} className="mt-2 text-xs text-muted-foreground">Saving producer preference…</p>
                                )}
                              </div>
                              {evaluated ? (
                                <div className="grid gap-3 border-t pt-3 text-xs sm:grid-cols-2">
                                  <div className="sm:col-span-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <div className="font-medium text-foreground">Music Critic</div>
                                      <Badge variant="outline">
                                        {critic.coverage.availableDimensions} of {critic.coverage.totalDimensions} dimensions available
                                      </Badge>
                                    </div>
                                    {critic.coverage.sparse && (
                                      <Alert className="mt-2">
                                        <AlertTitle>Limited critic evidence</AlertTitle>
                                        <AlertDescription>
                                          This score is based on only {critic.coverage.availableDimensions} of {critic.coverage.totalDimensions} dimensions. You can still choose this candidate, but compare it with broader-evidence scores carefully.
                                        </AlertDescription>
                                      </Alert>
                                    )}
                                    <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                                      {Object.entries(critic.dimensions).map(([name, dimension]) => {
                                        return (
                                        <div key={name} className="rounded-md border bg-card p-2">
                                          <div className="flex items-center justify-between gap-2">
                                            <span className="font-medium capitalize">{name.replace(/([A-Z])/g, " $1")}</span>
                                            <Badge variant={dimension.status === "failed" ? "destructive" : "outline"}>
                                              {dimension.status === "available" && dimension.score !== null
                                                ? `${Math.round(dimension.score * 100)}`
                                                : dimension.status}
                                            </Badge>
                                          </div>
                                          <p className="mt-1 text-[10px] text-muted-foreground">{dimension.explanation}</p>
                                          {dimension.evidence.map((item, index) => (
                                            <p key={`${item.source}-${index}`} className="mt-1 text-[10px] text-muted-foreground">
                                              {item.summary}
                                            </p>
                                          ))}
                                          {dimension.findings.length > 0 && (
                                            <div className="mt-2 space-y-2">
                                              {dimension.findings.map((finding) => {
                                                const eligible = isRepairEligible(
                                                  candidate,
                                                  dimension,
                                                  repair,
                                                  finding,
                                                );
                                                return (
                                                  <div key={finding.id} className="rounded border bg-muted/20 p-2">
                                                    <div className="font-medium text-foreground">
                                                      {finding.affectedSections.join(" · ")} · Bars {finding.startBar}–{finding.endBar}
                                                    </div>
                                                    <div className="mt-1 text-[10px] text-muted-foreground">
                                                      Tracks: {finding.affectedTrackIds.map((trackId) =>
                                                        candidate.trackModels?.find((track) => track.id === trackId)?.instrument ?? trackId
                                                      ).join(" · ")}
                                                    </div>
                                                    <p className="mt-1 text-[10px] text-muted-foreground">
                                                      {finding.musicalReason}
                                                    </p>
                                                    {eligible && (
                                                      <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        className="mt-2 h-7 w-full text-[10px]"
                                                        onClick={() => setRepairPreview({
                                                          candidate,
                                                          dimensionName: name,
                                                          finding,
                                                        })}
                                                      >
                                                        <Wrench className="mr-1.5 h-3 w-3" />
                                                        Preview this repair
                                                      </Button>
                                                    )}
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          )}
                                        </div>
                                      )})}
                                    </div>
                                  </div>
                                  {repair && (
                                    <Alert
                                      className="sm:col-span-2"
                                      variant={!repair.outsideScopePreserved ? "destructive" : "default"}
                                    >
                                      <Wrench className="h-4 w-4" />
                                      <AlertTitle>
                                        {repairOutcomeTitle(repair)}
                                      </AlertTitle>
                                      <AlertDescription>
                                        {repair.musicalReason} Source score {Math.round(repair.sourceQualityScore * 100)}
                                        {repair.repairedQualityScore === null
                                          ? "; repaired score unavailable."
                                          : `; repaired score ${Math.round(repair.repairedQualityScore * 100)}.`}
                                        {" "}Attempt {repair.attempt} of {repair.maxAttempts}. The original candidate remains unchanged.
                                      </AlertDescription>
                                    </Alert>
                                  )}
                                  <div>
                                    <div className="font-medium text-foreground">Strongest dimensions</div>
                                    <div className="mt-1 text-muted-foreground">
                                      {quality.strengths.join(" · ")}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="font-medium text-foreground">Weakest dimensions</div>
                                    <div className="mt-1 text-muted-foreground">
                                      {quality.weaknesses.join(" · ")}
                                    </div>
                                  </div>
                                  <div className="flex flex-wrap gap-2 sm:col-span-2 mt-2">
                                    {candidate.evaluation.artifacts.map((artifact) => (
                                      <Button key={artifact.id} size="sm" variant="outline" asChild>
                                        <a href={artifact.url} download>
                                          <Download className="mr-1.5 h-3.5 w-3.5" />
                                          {artifact.label}
                                        </a>
                                      </Button>
                                    ))}
                                  </div>

                                  <div className="sm:col-span-2 mt-4 space-y-3">
                                    <div className="font-medium text-foreground border-b pb-1">Arrangement Plan</div>
                                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                      {(candidate.plan.sections as any[]).map((section, idx) => (
                                        <div key={idx} className="rounded-md border p-2 bg-card text-xs">
                                          <div className="flex items-center justify-between mb-1">
                                            <span className="font-semibold text-foreground truncate mr-2">{section.section || section.name || `Section ${idx+1}`}</span>
                                            <span className="text-muted-foreground text-[10px] whitespace-nowrap">Bar {section.startBar}-{section.endBar}</span>
                                          </div>
                                          <div className="text-muted-foreground grid grid-cols-2 gap-1 mt-2">
                                            <div>Tracks: {section.activeTracks?.length ?? section.tracks?.length ?? 0}</div>
                                            <div>Energy: {Math.round((section.energy ?? 0) * 100)}%</div>
                                            <div>Density: {Math.round((section.density ?? 0) * 100)}%</div>
                                            {(section.trackDirectives && Object.keys(section.trackDirectives).length > 0) ? (
                                              <div className="truncate col-span-2 text-[10px]">Directives: {Object.keys(section.trackDirectives).length}</div>
                                            ) : null}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>

                                  <div className="sm:col-span-2 mt-2 space-y-3">
                                    <div className="font-medium text-foreground border-b pb-1">Harmony Decisions</div>
                                    {candidate.harmonyDecisions.length > 0 ? (
                                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                        {candidate.harmonyDecisions.map((decision, decisionIndex) => (
                                          <div key={`${decision.start}-${decision.symbol}-${decisionIndex}`} className="rounded-md border bg-card p-2 text-xs">
                                            <div className="flex items-center justify-between gap-2">
                                              <span className="font-mono font-semibold text-foreground">{decision.symbol}</span>
                                              <Badge variant="outline" className="text-[9px]">
                                                {decision.source === "deterministic_candidate_scoring" ? "engine choice" : "Song Model"}
                                              </Badge>
                                            </div>
                                            <div className="mt-1 text-[10px] text-muted-foreground">
                                              {decision.function ?? "Function not recorded"} · {decision.start.toFixed(2)}–{decision.end.toFixed(2)}s
                                            </div>
                                            {decision.source === "deterministic_candidate_scoring" && (
                                              <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-muted-foreground">
                                                <span>Melody {decision.melodyFit !== undefined ? `${Math.round(decision.melodyFit * 100)}%` : "not scored"}</span>
                                                <span>Bass {decision.bassFit !== undefined ? `${Math.round(decision.bassFit * 100)}%` : "not scored"}</span>
                                                <span>Voice leading {decision.voiceLeading !== undefined ? decision.voiceLeading.toFixed(2) : "not scored"}</span>
                                                <span>Total {decision.score !== undefined ? decision.score.toFixed(2) : "not scored"}</span>
                                              </div>
                                            )}
                                            {decision.candidateRationale?.length ? (
                                              <div className="mt-2 text-[10px] text-muted-foreground">
                                                Considered: {decision.candidateRationale.map((candidateChoice) =>
                                                  `${candidateChoice.function} ${candidateChoice.score.toFixed(2)}${candidateChoice.selected ? " (selected)" : ""}`
                                                ).join(" · ")}
                                              </div>
                                            ) : null}
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      <div className="text-xs italic text-muted-foreground">No harmony decision evidence was recorded for this candidate.</div>
                                    )}
                                  </div>

                                  <div className="sm:col-span-2 mt-2 space-y-3">
                                    <div className="font-medium text-foreground border-b pb-1">Orchestration Models</div>
                                    {candidate.trackModels && candidate.trackModels.length > 0 ? (
                                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                        {candidate.trackModels.map((track) => (
                                          <div key={track.id} className="rounded-md border p-2 bg-card text-xs">
                                            <div className="flex items-center justify-between mb-1">
                                              <span className="font-semibold text-foreground truncate mr-2" title={track.instrument}>{track.instrument}</span>
                                              <Badge variant="outline" className="text-[9px] uppercase px-1 py-0 h-4 whitespace-nowrap">{track.role}</Badge>
                                            </div>
                                            <div className="text-muted-foreground flex items-center justify-between mt-2 text-[10px]">
                                              <span>{track.notes?.length ?? 0} notes</span>
                                              <span>{track.cc?.length ?? 0} CCs</span>
                                              <span>{track.articulations?.length ?? 0} arts</span>
                                            </div>
                                            <div className="mt-2 text-muted-foreground text-[10px] flex justify-between">
                                              <span>Model:</span>
                                              <span className="truncate ml-2" title={track.provenance?.model || "Standard"}>
                                                {track.provenance?.model || "Standard"} {track.provenance?.version ? `v${track.provenance.version}` : ""}
                                              </span>
                                            </div>
                                            <div className="mt-3 space-y-2 border-t pt-2" data-testid={`track-decision-${track.id}`}>
                                              <div>
                                                <div className="text-[9px] font-semibold uppercase tracking-wider text-foreground">Directive</div>
                                                {track.appliedDirectives?.length ? (
                                                  <div className="mt-1 space-y-2">
                                                    {track.appliedDirectives.map((applied) => (
                                                      <div key={`${applied.section}-${applied.startBar}-${applied.endBar}`} className="rounded border p-2">
                                                        <div className="mb-1 text-[9px] font-medium uppercase text-foreground">
                                                          {applied.section} · bars {applied.startBar}–{applied.endBar}
                                                        </div>
                                                        <div className="flex flex-wrap gap-1">
                                                          {applied.directive.role && <Badge variant="secondary" className="text-[9px]">role {applied.directive.role}</Badge>}
                                                          {applied.directive.register && <Badge variant="outline" className="text-[9px]">register {applied.directive.register}</Badge>}
                                                          {applied.directive.articulationFamily && <Badge variant="outline" className="text-[9px]">{applied.directive.articulationFamily}</Badge>}
                                                          {applied.directive.dynamicTarget !== undefined && <Badge variant="outline" className="text-[9px]">dynamic {Math.round(applied.directive.dynamicTarget * 100)}%</Badge>}
                                                          {applied.directive.rhythmicActivity !== undefined && <Badge variant="outline" className="text-[9px]">rhythm {Math.round(applied.directive.rhythmicActivity * 100)}%</Badge>}
                                                          {applied.directive.harmonicActivity !== undefined && <Badge variant="outline" className="text-[9px]">harmony {Math.round(applied.directive.harmonicActivity * 100)}%</Badge>}
                                                          {applied.directive.fill !== undefined && <Badge variant="outline" className="text-[9px]">{applied.directive.fill ? "fill enabled" : "no fill"}</Badge>}
                                                          {applied.directive.transition && <Badge variant="outline" className="text-[9px]">transition {applied.directive.transition}</Badge>}
                                                        </div>
                                                      </div>
                                                    ))}
                                                  </div>
                                                ) : <div className="mt-1 italic text-muted-foreground">No orchestration directive was recorded.</div>}
                                              </div>
                                              <div>
                                                <div className="text-[9px] font-semibold uppercase tracking-wider text-foreground">Resolved mapping</div>
                                                {track.mapping ? (
                                                  <div className="mt-1 space-y-1 text-muted-foreground">
                                                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                                                      <span>{track.mapping.midiChannel !== undefined ? `MIDI channel ${track.mapping.midiChannel}` : "MIDI channel not recorded"}</span>
                                                      <span>{track.mapping.program !== undefined ? `program ${track.mapping.program}` : "program not recorded"}</span>
                                                    </div>
                                                    <div>
                                                      {Object.keys(track.mapping.articulationMap ?? {}).length
                                                        ? `Articulations: ${Object.entries(track.mapping.articulationMap ?? {}).map(([name, value]) => `${name}→${value}`).join(", ")}`
                                                        : "No articulation mapping recorded."}
                                                    </div>
                                                    <div>
                                                      {Object.keys(track.mapping.controlMap ?? {}).length
                                                        ? `Controls: ${Object.entries(track.mapping.controlMap ?? {}).map(([name, value]) => `${name}→CC${value}`).join(", ")}`
                                                        : "No control mapping recorded."}
                                                    </div>
                                                  </div>
                                                ) : <div className="mt-1 italic text-muted-foreground">No resolved renderer mapping was recorded.</div>}
                                              </div>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      <div className="text-muted-foreground italic text-xs">No distinct orchestration models provided.</div>
                                    )}
                                  </div>

                                  {quality.warnings.length > 0 && (
                                    <div className="text-amber-700 dark:text-amber-400 sm:col-span-2">
                                      {quality.warnings.join(" ")}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <Alert variant="destructive">
                                  <Activity className="h-4 w-4" />
                                  <AlertTitle>Candidate fenced from ranking</AlertTitle>
                                  <AlertDescription>
                                    {candidate.evaluation.error ?? "Render or quality evidence is unavailable."}
                                  </AlertDescription>
                                </Alert>
                              )}
                            </CardContent>
                          </Card>
                        );
                      })}
                   </div>
                 ) : (
                   <div className="text-center py-12 border rounded-xl bg-card border-dashed">
                     <Sparkles className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                     <h3 className="text-lg font-semibold">Generate variations</h3>
                     <p className="text-muted-foreground text-sm max-w-sm mx-auto mt-2">
                       Adjust your creative parameters in the Director tab and hit generate to see candidates here.
                     </p>
                   </div>
                 )}
               </div>
            </TabsContent>
          </Tabs>
        </main>

        {/* Right Panel: Copilot */}
        <aside className="hidden w-[300px] border-l bg-card flex-col shrink-0 z-10 shadow-[-2px_0_10px_rgba(0,0,0,0.02)] md:flex">
          {renderCopilotPanel()}
        </aside>

      </div>

      {/* Mobile panel sheets overlay the editor so the workspace width and selection never change. */}
      {isMobile && (
        <Sheet open={mobilePanel !== null} onOpenChange={(open) => !open && setMobilePanel(null)}>
          <SheetContent
            side={mobilePanel === "tracks" ? "left" : "right"}
            className="w-[min(88vw,340px)] p-0 flex flex-col gap-0"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{mobilePanel === "tracks" ? "Tracks" : "Studio Copilot"}</SheetTitle>
              <SheetDescription>
                {mobilePanel === "tracks" ? "Track controls" : "Ask Studio Copilot for arrangement help"}
              </SheetDescription>
            </SheetHeader>
            <div className={cn("flex min-h-0 flex-1 flex-col", mobilePanel === "tracks" ? "bg-sidebar" : "bg-card")}>
              {mobilePanel === "tracks" ? renderTracksPanel() : renderCopilotPanel()}
            </div>
          </SheetContent>
        </Sheet>
      )}

        <Dialog open={Boolean(repairPreview)} onOpenChange={(open) => !open && setRepairPreview(null)}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Review bounded critic repair</DialogTitle>
              <DialogDescription>
                Confirm the exact musical scope before requesting a deterministic repair. The original candidate will not be replaced.
              </DialogDescription>
            </DialogHeader>
            {repairPreview && (
              <div className="space-y-4 text-sm">
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="font-medium">{repairPreview.candidate.label}</div>
                  <div className="mt-1 text-xs capitalize text-muted-foreground">
                    Music Critic · {repairPreview.dimensionName.replace(/([A-Z])/g, " $1")}
                  </div>
                </div>
                <div>
                  <Label>Musical reason</Label>
                  <p className="mt-1 rounded-md border p-3 text-muted-foreground">
                    {repairPreview.finding.musicalReason}
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-md border p-3">
                    <div className="text-xs font-medium uppercase text-muted-foreground">Sections and bars</div>
                    <div className="mt-2">{repairPreview.finding.affectedSections.join(" · ")}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Bars {repairPreview.finding.startBar}–{repairPreview.finding.endBar}
                    </div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs font-medium uppercase text-muted-foreground">Tracks</div>
                    <div className="mt-2">
                      {repairPreview.finding.affectedTrackIds.map((trackId) =>
                        repairPreview.candidate.trackModels?.find((track) => track.id === trackId)?.instrument ?? trackId
                      ).join(" · ")}
                    </div>
                  </div>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setRepairPreview(null)}>Cancel</Button>
              <Button onClick={handleRepairCandidate} disabled={repairGenerationCandidate.isPending}>
                {repairGenerationCandidate.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Request bounded repair
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileArchive className="h-5 w-5 text-primary" />
              Export production package
            </DialogTitle>
            <DialogDescription>
              Render DAW-compatible 16-bit WAV files, a multitrack MIDI arrangement,
              and a versioned ZIP package saved to the project.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-4">
                <Checkbox
                  checked={includeStems}
                  onCheckedChange={(checked) => setIncludeStems(checked === true)}
                />
                <span>
                  <span className="block text-sm font-semibold">Audio stems</span>
                  <span className="text-xs text-muted-foreground">
                    Individual 16-bit WAV file for every active track
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-4">
                <Checkbox
                  checked={includeMidi}
                  onCheckedChange={(checked) => setIncludeMidi(checked === true)}
                />
                <span>
                  <span className="block text-sm font-semibold">Multitrack MIDI</span>
                  <span className="text-xs text-muted-foreground">
                    Tempo, meter, programs, notes, and track channels
                  </span>
                </span>
              </label>
            </div>

            <div className="space-y-2">
              <Label>Mastering profile</Label>
              <Select value={masterProfile} onValueChange={setMasterProfile}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="STREAMING">Streaming balanced</SelectItem>
                  <SelectItem value="DYNAMIC">Dynamic / acoustic</SelectItem>
                  <SelectItem value="CLASSICAL">Classical headroom</SelectItem>
                  <SelectItem value="POP">Modern pop</SelectItem>
                  <SelectItem value="LOUD">Loud master</SelectItem>
                  <SelectItem value="FILM">Film and sync</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {exportResult && (
               <div className="space-y-5 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700">
                  <Check className="h-4 w-4" />
                  Export ready
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {exportResult.files.length} files are stored as project artifacts.
                </p>
                <div className="mt-3 max-h-32 space-y-1 overflow-auto">
                  {exportResult.files.map((file) => (
                    <button
                      key={`${file.type}-${file.name}`}
                      type="button"
                      onClick={() => downloadFile(file.url)}
                      className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-background"
                    >
                      <span className="truncate font-mono">{file.name}</span>
                      <span className="ml-3 shrink-0 text-muted-foreground">{file.size}</span>
                    </button>
                  ))}
                </div>
                 <div className="border-t border-emerald-500/15 pt-4">
                   <ExportRenderEvidence evidence={exportEvidence} />
                 </div>
              </div>
            )}
             {!exportResult && latestReadyExport && (
               <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
                 <div>
                   <p className="text-sm font-semibold">Latest completed export</p>
                   <p className="mt-1 text-xs text-muted-foreground">
                     Renderer evidence remains available here after the project is reopened.
                   </p>
                 </div>
                 <ExportRenderEvidence evidence={exportEvidence} />
               </div>
             )}
          </div>

          <DialogFooter>
            {exportResult ? (
              <Button onClick={() => downloadFile(exportResult.bundleUrl)}>
                <Download className="mr-2 h-4 w-4" />
                Download ZIP again
              </Button>
            ) : (
              <Button onClick={handleExport} disabled={createExport.isPending || Boolean(exportJobId && exportJob?.status !== "failed")}>
                {createExport.isPending || (exportJobId && exportJob?.status !== "failed") ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                {createExport.isPending
                  ? "Queueing export..."
                  : exportJobId && exportJob?.status !== "failed"
                    ? `Rendering files${exportJob ? ` (${exportJob.progress}%)` : ""}...`
                    : "Render and download"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function generationFailure(error: unknown): { title: string; description: string } {
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as {
      data?: { error?: unknown; action?: unknown };
    }).data;
    if (typeof data?.error === "string") {
      return {
        title: "Generation Blocked",
        description: typeof data.action === "string"
          ? `${data.error} ${data.action}`
          : data.error,
      };
    }
  }
  return {
    title: "Generation Failed",
    description: error instanceof Error
      ? error.message
      : "The selected provider could not generate candidates.",
  };
}

function parseDuration(value: string | undefined): number {
  if (!value) return 0;
  const parts = value.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}
