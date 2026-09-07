import { useEffect, useRef, useState } from "react";
import {
  getGetProjectQueryKey,
  getGetProjectSongModelQueryKey,
  getListAnalysisJobsQueryKey,
  getListProjectSourcesQueryKey,
  ProjectSource,
  SongModelFieldStatusProperty,
  useCorrectProjectSongModel,
  useGetProjectSongModel,
  useListAnalysisJobs,
  useListMusicProviders,
  useListProjectSources,
  useRetryProjectSourceAnalysis,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  BarChart2,
  CheckCircle2,
  Clock,
  Cpu,
  FileAudio,
  FileType2,
  Hash,
  Loader2,
  Layers,
  Mic,
  Music2,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Timer,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { ResponsiveContainer, AreaChart, Area, Tooltip } from "recharts";

interface SongModelInspectorProps {
  projectId: string;
}

export function SongModelInspector({ projectId }: SongModelInspectorProps) {
  const queryClient = useQueryClient();
  const refreshedCompletedJobRef = useRef<string | null>(null);
  const { data: jobs, isLoading: jobsLoading } = useListAnalysisJobs(projectId, {
    query: {
      queryKey: getListAnalysisJobsQueryKey(projectId),
      retry: false,
      refetchInterval: (query) => query.state.data?.some((job) =>
        job.status === "running" || job.status === "queued"
      ) ? 2_000 : false,
    },
  });
  const {
    data: sources,
    error: sourcesError,
    isLoading: sourcesLoading,
  } = useListProjectSources(projectId, {
    query: {
      queryKey: getListProjectSourcesQueryKey(projectId),
      retry: false,
      refetchInterval: (query) => {
        const data = query.state.data as ProjectSource[] | undefined;
        return data?.some((source) =>
          ["queued", "preprocessing", "analyzing"].includes(source.status)
        ) ? 1_500 : false;
      },
    },
  });
  const latestSource = sources?.[0];
  const sourceIsProcessing = Boolean(
    latestSource && ["queued", "preprocessing", "analyzing"].includes(latestSource.status),
  );
  const hasActiveJob = jobs?.some((job) =>
    job.status === "running" || job.status === "queued"
  ) ?? false;
  const {
    data: model,
    error: modelError,
    isLoading,
    isError,
    refetch: refetchModel,
  } = useGetProjectSongModel(projectId, {
    query: {
      queryKey: getGetProjectSongModelQueryKey(projectId),
      retry: false,
      refetchInterval: sourceIsProcessing || hasActiveJob ? 1_500 : false,
    },
  });
  const { data: providers } = useListMusicProviders();
  const retryAnalysis = useRetryProjectSourceAnalysis();
  const correctModel = useCorrectProjectSongModel();
  const readySourceRef = useRef<string | null>(null);
  const currentSource = model
    ? sources?.find((source) => source.id === model.sourceId) ?? latestSource
    : latestSource;
  const accessDenied = [getErrorStatus(sourcesError), getErrorStatus(modelError)]
    .some((status) => status === 401 || status === 403);
  const [bpm, setBpm] = useState("");
  const [key, setKey] = useState("");
  const [meter, setMeter] = useState("");
  const [sections, setSections] = useState<Array<{
    name: string;
    startBar: string;
    endBar: string;
  }>>([]);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [correctionNotice, setCorrectionNotice] = useState<string | null>(null);

  useEffect(() => {
    if (latestSource?.status !== "ready" || readySourceRef.current === latestSource.id) return;
    readySourceRef.current = latestSource.id;
    void refetchModel();
  }, [latestSource, refetchModel]);

  useEffect(() => {
    const latestCompleted = jobs?.find((job) => job.status === "completed");
    if (!latestCompleted || refreshedCompletedJobRef.current === latestCompleted.id) return;
    refreshedCompletedJobRef.current = latestCompleted.id;
    void queryClient.invalidateQueries({
      queryKey: getGetProjectSongModelQueryKey(projectId),
    });
  }, [jobs, projectId, queryClient]);

  useEffect(() => {
    if (!model) return;
    setBpm(model.tempoMap[0]?.bpm?.toString() ?? "");
    setKey(model.keyMap[0]?.key ?? "");
    setMeter(model.meterMap[0]?.meter ?? "");
    setSections(model.sections.map((section) => ({
      name: section.name,
      startBar: section.startBar.toString(),
      endBar: section.endBar.toString(),
    })));
    setCorrectionError(null);
  }, [model?.id]);

  const handleRetry = (sourceId: string) => {
    retryAnalysis.mutate({ projectId, sourceId }, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListAnalysisJobsQueryKey(projectId) });
        void queryClient.invalidateQueries({ queryKey: getGetProjectSongModelQueryKey(projectId) });
      },
    });
  };

  const saveCorrections = () => {
    if (!model) return;
    const parsedBpm = Number(bpm);
    if (!Number.isFinite(parsedBpm) || parsedBpm < 20 || parsedBpm > 400) {
      setCorrectionError("BPM must be a number between 20 and 400.");
      return;
    }
    if (!key.trim()) {
      setCorrectionError("Key is required.");
      return;
    }
    if (!/^[1-9]\d*\/[1-9]\d*$/.test(meter)) {
      setCorrectionError("Meter must use a format such as 4/4.");
      return;
    }
    const normalizedSections = sections.map((section) => ({
      name: section.name.trim(),
      startBar: Number(section.startBar),
      endBar: Number(section.endBar),
    }));
    if (normalizedSections.some((section, index) =>
      !section.name ||
      !Number.isInteger(section.startBar) ||
      !Number.isInteger(section.endBar) ||
      section.startBar < 1 ||
      section.endBar < section.startBar ||
      (index > 0 && section.startBar <= normalizedSections[index - 1].endBar)
    )) {
      setCorrectionError("Section names and ordered, non-overlapping bar boundaries are required.");
      return;
    }
    if (
      model.sections.length > 0 &&
      normalizedSections.length !== model.sections.length
    ) {
      setCorrectionError("Section corrections must retain the detected section count.");
      return;
    }
    const data: {
      baseVersion: number;
      bpm?: number;
      key?: string;
      meter?: string;
      sections?: Array<{ name: string; startBar: number; endBar: number }>;
    } = { baseVersion: model.version };
    if (parsedBpm !== model.tempoMap[0]?.bpm) data.bpm = parsedBpm;
    if (key.trim() !== (model.keyMap[0]?.key ?? "")) data.key = key.trim();
    if (meter !== (model.meterMap[0]?.meter ?? "")) data.meter = meter;
    if (normalizedSections.length !== model.sections.length || normalizedSections.some((section, index) => {
      const current = model.sections[index];
      return !current ||
        section.name !== current.name ||
        section.startBar !== current.startBar ||
        section.endBar !== current.endBar;
    })) {
      data.sections = normalizedSections;
    }
    if (Object.keys(data).length === 1) {
      setCorrectionError("Make a change before saving.");
      return;
    }
    setCorrectionError(null);
    setCorrectionNotice(null);
    correctModel.mutate({ projectId, data }, {
      onSuccess: (corrected) => {
        queryClient.setQueryData(
          getGetProjectSongModelQueryKey(projectId),
          corrected,
        );
        setBpm(corrected.tempoMap[0]?.bpm?.toString() ?? "");
        setKey(corrected.keyMap[0]?.key ?? "");
        setMeter(corrected.meterMap[0]?.meter ?? "");
        setSections(corrected.sections.map((section) => ({
          name: section.name,
          startBar: section.startBar.toString(),
          endBar: section.endBar.toString(),
        })));
        setCorrectionNotice(`Saved Song Model v${corrected.version}.`);
        void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      },
      onError: (error) => {
        setCorrectionError(error instanceof Error ? error.message : "Could not save Song Model corrections.");
      },
    });
  };

  if (isLoading || sourcesLoading || jobsLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-muted-foreground space-y-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" data-testid="icon-loading" />
        <p className="text-sm font-mono tracking-widest uppercase">Retrieving Song Model</p>
      </div>
    );
  }

  if (isError || !model) {
    return (
      <div className="space-y-4 p-4 lg:p-6">
        <AnalysisActivity
          jobs={jobs}
          retrying={retryAnalysis.isPending}
          onRetry={handleRetry}
        />
        <SourceAnalysisState source={currentSource} accessDenied={accessDenied} />
      </div>
    );
  }

  const warningFields = Object.entries(model.fieldStatus).filter(([, value]) =>
    value.status === "low_confidence" ||
    value.status === "failed" ||
    value.status === "not_available"
  );
  const editedFields = Object.values(model.fieldStatus).filter((value) => value.edited);

  return (
    <div className="flex flex-col h-full space-y-4 p-4 lg:p-6" data-testid="song-model-inspector">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            Analysis Model
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Raw detection output. This data drives the generative arrangement engine.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap text-xs">
          <Badge variant="outline" className="font-mono bg-card" data-testid="badge-version">
            v{model.version}
          </Badge>
          <Badge
            variant="outline"
            className={cn(
              "font-mono shadow-sm",
              model.confidence <= 0 ? "bg-muted text-muted-foreground border-border" :
              model.confidence > 0.8 ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/30" :
              model.confidence > 0.5 ? "bg-yellow-500/10 text-yellow-600 border-yellow-500/30" :
              "bg-red-500/10 text-red-600 border-red-500/30"
            )}
            data-testid="badge-confidence"
          >
            {model.confidence > 0.8 ? <ShieldCheck className="h-3 w-3 mr-1" /> : <ShieldAlert className="h-3 w-3 mr-1" />}
            {model.confidence > 0
              ? `${Math.round(model.confidence * 100)}% Confidence`
              : "Confidence unavailable"}
          </Badge>
        </div>
      </div>

      <AnalysisActivity
        jobs={jobs}
        retrying={retryAnalysis.isPending}
        onRetry={handleRetry}
      />

      <Card
        className={cn(
          model.validation.status === "accepted"
            ? "border-emerald-500/25"
            : "border-amber-500/35",
        )}
        data-testid="song-model-validation"
      >
        <CardHeader className="p-4 pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              {model.validation.status === "accepted"
                ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                : <AlertTriangle className="h-4 w-4 text-amber-600" />}
              Canonical validation
            </CardTitle>
            <Badge
              variant="outline"
              className={cn(
                model.validation.status === "accepted"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-700",
              )}
            >
              {model.validation.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">Selected provider</span>
            <span className="font-mono font-medium" data-testid="fusion-selected-provider">
              {model.fusion.selectedProvider || "None — all candidates rejected"}
            </span>
            <span className="text-muted-foreground">Fusion confidence</span>
            <span className="font-mono">{Math.round(model.fusion.confidence * 100)}%</span>
          </div>
          {model.validation.issues.length > 0 && (
            <div className="space-y-1.5" data-testid="validation-issues">
              {model.validation.issues.map((issue, index) => (
                <div
                  key={`${issue.code}-${issue.path}-${index}`}
                  className={cn(
                    "rounded border px-3 py-2 text-xs",
                    issue.severity === "error"
                      ? "border-destructive/25 bg-destructive/5"
                      : "border-amber-500/25 bg-amber-500/5",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="h-5 text-[9px]">
                      {issue.severity}
                    </Badge>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {issue.path || "song model"} · {issue.code}
                    </span>
                    {issue.provider && (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {issue.provider}
                      </span>
                    )}
                  </div>
                  <p className="mt-1">{issue.message}</p>
                </div>
              ))}
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid="fusion-decisions">
            {model.fusion.decisions.map((decision, index) => (
              <div key={`${decision.provider}-${index}`} className="rounded border bg-muted/15 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs">{decision.provider}</span>
                  <Badge variant="outline" className="h-5 text-[9px]">{decision.status}</Badge>
                </div>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                  Confidence {Math.round(decision.confidence * 100)}% · compatibility{" "}
                  {Math.round(decision.compatibility * 100)}%
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border bg-card px-4 py-3 text-xs">
        <div className="flex items-center gap-2">
          <Badge className="bg-sky-500/10 text-sky-700 border-sky-500/30" variant="outline">
            Detected
          </Badge>
          <span className="text-muted-foreground">Provider output stored in Song Model v{model.version}</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="bg-violet-500/10 text-violet-700 border-violet-500/30" variant="outline">
            User edit
          </Badge>
          <span className="text-muted-foreground" data-testid="text-user-edit-state">
            {editedFields.length ? `${editedFields.length} edited fields` : "No user edits recorded"}
          </span>
        </div>
      </div>

      {warningFields.length > 0 && (
        <div
          className="flex flex-wrap items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3"
          data-testid="song-model-quality-warnings"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold">Review {warningFields.length} fields before arranging</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {warningFields.map(([field, value]) => (
                <FieldStatusBadge key={field} field={field} value={value} />
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 shrink-0">
        <Card className="shadow-sm">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <Cpu className="h-3.5 w-3.5" /> Providers
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {model.providers.length > 0 ? (
              <div className="flex flex-wrap gap-1 mt-1" data-testid="list-providers">
                {model.providers.map(p => (
                  <Badge key={p} variant="secondary" className="text-[10px] font-mono px-1.5 py-0">
                    {p}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground mt-1 italic" data-testid="text-no-providers">No providers recorded</p>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <FileAudio className="h-3.5 w-3.5" /> Source Audio
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="grid grid-cols-2 gap-x-2 gap-y-1 mt-1 text-xs" data-testid="audio-metadata">
              <div className="text-muted-foreground">File</div>
              <div className="truncate font-mono text-right" title={model.audio.name}>{model.audio.name}</div>

              <div className="text-muted-foreground">Size</div>
              <div className="font-mono text-right">{formatBytes(model.audio.size)}</div>

              <div className="text-muted-foreground">Format</div>
              <div className="font-mono text-right">{model.audio.contentType.split('/')[1] || model.audio.contentType}</div>

              <div className="text-muted-foreground">Sample Rate</div>
              <div className="font-mono text-right">{model.audio.sampleRate.toLocaleString()} Hz</div>

              <div className="text-muted-foreground">Channels</div>
              <div className="font-mono text-right">{model.audio.channels}</div>

              <div className="text-muted-foreground">Duration</div>
              <div className="font-mono text-right">{formatTime(model.audio.durationSeconds)}</div>

              <div className="text-muted-foreground">Imported</div>
              <div className="font-mono text-right">
                {currentSource ? new Date(currentSource.createdAt).toLocaleDateString() : "—"}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm md:col-span-2">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <BarChart2 className="h-3.5 w-3.5" /> Global Energy
              <FieldStatusBadge field="energy" value={model.fieldStatus.energy} compact />
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
             {isFieldUsable(model.fieldStatus.energy) && model.energy.length > 0 ? (
                <div className="h-16 w-full mt-1" data-testid="chart-energy">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={model.energy.map((val, i) => ({ frame: i, energy: val }))} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="energyGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.8}/>
                          <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <Tooltip
                        content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            return (
                              <div className="bg-popover border text-popover-foreground text-xs p-1 px-2 rounded shadow-md font-mono">
                                E: {Number(payload[0].value).toFixed(2)}
                              </div>
                            );
                          }
                          return null;
                        }}
                      />
                      <Area type="monotone" dataKey="energy" stroke="hsl(var(--primary))" fill="url(#energyGrad)" strokeWidth={1.5} isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
             ) : (
               <p className="text-xs text-muted-foreground mt-1 italic text-center py-4 border border-dashed rounded" data-testid="text-no-energy">
                  {fieldEmptyMessage(model.fieldStatus.energy, "No energy values were detected.")}
               </p>
             )}
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm" data-testid="card-vocal-evidence">
        <CardHeader className="p-4 pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <Mic className="h-3.5 w-3.5" /> Vocal Evidence
            </CardTitle>
            <Badge
              variant="outline"
              className={cn(
                "capitalize font-mono text-[10px]",
                model.vocalEvidence?.status === "detected" ? "bg-sky-500/10 text-sky-700 border-sky-500/30" :
                model.vocalEvidence?.status === "low_confidence" ? "bg-amber-500/10 text-amber-700 border-amber-500/30" :
                model.vocalEvidence?.status === "failed" ? "bg-destructive/10 text-destructive border-destructive/30" :
                "bg-muted text-muted-foreground border-border"
              )}
            >
              {model.vocalEvidence?.status?.replace("_", " ") ?? "Not available"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {!model.vocalEvidence || model.vocalEvidence.status === "not_available" ? (
            <p className="text-xs text-muted-foreground italic text-center py-4 border border-dashed rounded mt-1">
              {model.vocalEvidence?.reason || "No vocal evidence was computed for this source."}
            </p>
          ) : model.vocalEvidence.status === "failed" ? (
            <div className="flex flex-col items-center justify-center py-4 border border-dashed border-destructive/30 rounded bg-destructive/5 text-destructive space-y-1 mt-1">
              <AlertTriangle className="h-4 w-4 mb-1" />
              <p className="text-xs font-medium">Vocal analysis failed</p>
              <p className="text-[10px] opacity-80">{model.vocalEvidence.reason || "An error occurred during detection."}</p>
            </div>
          ) : (
            <div className="space-y-4 mt-2">
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Provenance</div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
                    <span className="text-muted-foreground">Provider</span>
                    <span className="font-mono text-right truncate" title={model.vocalEvidence.provenance?.provider}>
                      {model.vocalEvidence.provenance?.provider || "—"}
                    </span>
                    <span className="text-muted-foreground">Stem Role</span>
                    <span className="font-mono text-right capitalize truncate">
                      {model.vocalEvidence.provenance?.sourceStemRole || "—"}
                    </span>
                    <span className="text-muted-foreground">Checksum</span>
                    <span className="font-mono text-right truncate" title={model.vocalEvidence.provenance?.contentChecksum}>
                      {model.vocalEvidence.provenance?.contentChecksum?.substring(0, 8) || "—"}
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Context & Thresholds</div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
                    <span className="text-muted-foreground">Sample Rate</span>
                    <span className="font-mono text-right">{model.vocalEvidence.sampleRate ? `${model.vocalEvidence.sampleRate} Hz` : "—"}</span>
                    <span className="text-muted-foreground">Activity Ratio</span>
                    <span className="font-mono text-right">{model.vocalEvidence.thresholds?.activityRatio != null ? `${Math.round(model.vocalEvidence.thresholds.activityRatio * 100)}%` : "—"}</span>
                    <span className="text-muted-foreground">RMS Threshold</span>
                    <span className="font-mono text-right">{model.vocalEvidence.thresholds?.rms != null ? model.vocalEvidence.thresholds.rms.toFixed(3) : "—"}</span>
                  </div>
                </div>

                <div className="space-y-2 lg:col-span-1 md:col-span-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Timeline Windows</div>
                  <div className="flex gap-2">
                    <div className="flex-1 rounded border bg-sky-500/5 border-sky-500/20 p-2 text-center">
                      <div className="text-lg font-mono text-sky-600 font-semibold leading-none">{model.vocalEvidence.observedVoicedWindows?.length ?? 0}</div>
                      <div className="text-[10px] uppercase tracking-wider text-sky-600/70 mt-1">Voiced</div>
                    </div>
                    <div className="flex-1 rounded border bg-muted/30 p-2 text-center">
                      <div className="text-lg font-mono text-muted-foreground font-semibold leading-none">{model.vocalEvidence.observedSilentWindows?.length ?? 0}</div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-1">Silent</div>
                    </div>
                  </div>
                </div>
              </div>

              {(model.vocalEvidence.observedVoicedWindows?.length > 0 || model.vocalEvidence.observedSilentWindows?.length > 0) && (
                <div className="space-y-1.5">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Vocal Activity Timeline</div>
                  <div className="relative h-6 w-full bg-card rounded overflow-hidden border">
                    {model.vocalEvidence.observedSilentWindows?.map((w, i) => (
                      <div
                        key={`silent-${i}`}
                        className="absolute h-full bg-muted/40"
                        style={{
                          left: `${(w.start / (model.audio.durationSeconds || 1)) * 100}%`,
                          width: `${((w.end - w.start) / (model.audio.durationSeconds || 1)) * 100}%`
                        }}
                        title={`Silent: ${formatTime(w.start)} - ${formatTime(w.end)}`}
                      />
                    ))}
                    {model.vocalEvidence.observedVoicedWindows?.map((w, i) => (
                      <div
                        key={`voiced-${i}`}
                        className="absolute h-full bg-sky-500/40 border-x border-sky-500/50"
                        style={{
                          left: `${(w.start / (model.audio.durationSeconds || 1)) * 100}%`,
                          width: `${((w.end - w.start) / (model.audio.durationSeconds || 1)) * 100}%`
                        }}
                        title={`Voiced: ${formatTime(w.start)} - ${formatTime(w.end)}`}
                      />
                    ))}
                  </div>
                </div>
              )}
              {model.vocalIntelligence && (
                <div className="space-y-2 border-t pt-3" data-testid="vocal-intelligence-summary">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Phrase intelligence v{model.vocalIntelligence.version}
                    </div>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {model.vocalIntelligence.phrases.status.replace("_", " ")}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <div className="rounded border p-2">
                      <div className="text-lg font-mono font-semibold">{model.vocalIntelligence.phrases.events.length}</div>
                      <div className="text-[10px] uppercase text-muted-foreground">Phrases</div>
                    </div>
                    <div className="rounded border p-2">
                      <div className="text-lg font-mono font-semibold">{model.vocalIntelligence.breaths.events.length}</div>
                      <div className="text-[10px] uppercase text-muted-foreground">Breaths</div>
                    </div>
                    <div className="rounded border p-2">
                      <div className="text-lg font-mono font-semibold">{model.vocalIntelligence.arrangementSpace.windows.length}</div>
                      <div className="text-[10px] uppercase text-muted-foreground">Open spaces</div>
                    </div>
                    <div className="rounded border p-2">
                      <div className="text-xs font-mono font-semibold capitalize">{model.vocalIntelligence.melodyAlignment.status.replace("_", " ")}</div>
                      <div className="text-[10px] uppercase text-muted-foreground">Melody link</div>
                    </div>
                  </div>
                  {[
                    model.vocalIntelligence.phrases.reason,
                    model.vocalIntelligence.breaths.reason,
                    model.vocalIntelligence.lyricAlignment.reason,
                    model.vocalIntelligence.melodyAlignment.reason,
                    model.vocalIntelligence.arrangementSpace.reason,
                  ].filter((reason): reason is string => Boolean(reason)).map((reason) => (
                    <p key={reason} className="text-[10px] text-muted-foreground">{reason}</p>
                  ))}
                  {model.vocalIntelligence.arrangementSpace.windows.slice(0, 4).map((space) => (
                    <div key={space.id} className="flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
                      <span>{formatTime(space.start)}–{formatTime(space.end)}</span>
                      <span>Bars {space.bars.join(", ") || "unknown"}</span>
                      <span>{space.sections.join(", ") || "No known section"}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="rounded-md border bg-card px-4 py-3" data-testid="field-provenance">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Cpu className="h-3.5 w-3.5" />
          Field provenance
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {songModelFields.map((field) => {
            const providers = model.provenance[field] ?? [];
            return (
              <div key={field} className="flex min-w-0 items-center justify-between gap-3 rounded border bg-muted/15 px-2.5 py-2">
                <span className="text-xs font-medium capitalize">{field}</span>
                <span
                  className={cn(
                    "truncate text-right font-mono text-[10px]",
                    providers.length ? "text-foreground" : "text-muted-foreground",
                  )}
                  title={providers.length ? providers.join(", ") : "No provider output"}
                  data-testid={`provenance-${field}`}
                >
                  {providers.length ? providers.join(" · ") : "No provider output"}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {(model.providerProvenance.length > 0 || model.sourceStems.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                <Server className="h-3.5 w-3.5" />
                Provider capabilities
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 p-4 pt-0 sm:grid-cols-2">
              {model.providerProvenance.map((item) => (
                <div key={`${item.capability}-${item.provider}`} className="rounded border bg-muted/15 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium capitalize">
                      {item.capability.replace(/_/g, " ")}
                    </span>
                    <Badge variant="outline" className="h-5 text-[9px]">{item.status}</Badge>
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                    {item.provider} · {item.version}
                  </p>
                </div>
              ))}
              {providers?.filter((provider) => model.providers.includes(provider.id)).map((provider) => (
                <div key={`engine-${provider.id}`} className="rounded border border-dashed p-2">
                  <p className="truncate text-xs font-medium">{provider.name}</p>
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {provider.execution} · v{provider.version}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                <Layers className="h-3.5 w-3.5" />
                Source stems
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-4 pt-0">
              {model.sourceStems.length > 0 ? model.sourceStems.map((stem) => (
                <div key={`${stem.role}-${stem.objectPath}`} className="flex items-center justify-between gap-3 rounded border px-3 py-2">
                  <span className="text-xs font-medium capitalize">{stem.role}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {stem.provider} · {Math.round(stem.confidence * 100)}%
                  </span>
                </div>
              )) : (
                <p className="text-xs text-muted-foreground">No source stems were produced.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Card className="border-violet-500/25">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Correct before arranging</CardTitle>
          <p className="text-xs font-normal text-muted-foreground">
            Correct misheard tempo, key, meter, or section labels and boundaries. Saves an auditable Song Model version while retaining detected provider provenance.
          </p>
        </CardHeader>
        <CardContent className="space-y-4 p-4 pt-0">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="song-model-bpm">BPM</Label>
              <Input id="song-model-bpm" type="number" min="20" max="400" value={bpm} onChange={(event) => setBpm(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="song-model-key">Key</Label>
              <Input id="song-model-key" value={key} onChange={(event) => setKey(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="song-model-meter">Meter</Label>
              <Input id="song-model-meter" value={meter} onChange={(event) => setMeter(event.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label>Section labels and boundaries</Label>
              {model.sections.length === 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSections((current) => [
                    ...current,
                    {
                      name: "",
                      startBar: current.length
                        ? String(Number(current[current.length - 1].endBar || 0) + 1)
                        : "1",
                      endBar: "",
                    },
                  ])}
                  data-testid="button-add-song-model-section"
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add section
                </Button>
              )}
            </div>
            {sections.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No verified sections were detected. Add the boundaries you confirmed before arranging.
              </p>
            )}
            {sections.map((section, index) => (
              <div
                key={index}
                className={cn(
                  "grid gap-2",
                  model.sections.length === 0
                    ? "grid-cols-[minmax(0,1fr)_80px_80px_36px]"
                    : "grid-cols-[minmax(0,1fr)_80px_80px]",
                )}
              >
                <Input aria-label={`Section ${index + 1} name`} value={section.name} onChange={(event) => setSections((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} />
                <Input aria-label={`Section ${index + 1} start bar`} type="number" min="1" value={section.startBar} onChange={(event) => setSections((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, startBar: event.target.value } : item))} />
                <Input aria-label={`Section ${index + 1} end bar`} type="number" min="1" value={section.endBar} onChange={(event) => setSections((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, endBar: event.target.value } : item))} />
                {model.sections.length === 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove section ${index + 1}`}
                    onClick={() => setSections((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index)
                    )}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
          {correctionError && <p className="text-xs text-destructive" role="alert">{correctionError}</p>}
          {correctionNotice && <p className="text-xs text-emerald-600" role="status">{correctionNotice}</p>}
          <div className="flex justify-end">
            <Button onClick={saveCorrections} disabled={correctModel.isPending} data-testid="button-save-song-model-corrections">
              {correctModel.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save corrections
            </Button>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="tempo" className="flex-1 flex flex-col min-h-0">
        <TabsList className="justify-start shrink-0 w-full rounded-none border-b bg-transparent h-12 p-0 overflow-x-auto overflow-y-hidden space-x-6">
          <TabsTrigger value="tempo" data-testid="tab-tempo" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 data-[state=active]:shadow-none">
            Tempo & Meter
          </TabsTrigger>
          <TabsTrigger value="harmony" data-testid="tab-harmony" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 data-[state=active]:shadow-none">
            Harmony Map
          </TabsTrigger>
          <TabsTrigger value="melody" data-testid="tab-melody" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 data-[state=active]:shadow-none">
            Melody
          </TabsTrigger>
          <TabsTrigger value="sections" data-testid="tab-sections" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 data-[state=active]:shadow-none">
            Structure
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tempo" className="flex-1 min-h-0 overflow-hidden m-0 pt-4 flex gap-4">
          <div className="flex-1 border rounded-md bg-card overflow-hidden flex flex-col">
             <div className="px-4 py-2 border-b bg-muted/20 font-semibold text-xs flex items-center gap-2">
               <Clock className="h-4 w-4" /> Tempo Events
               <FieldStatusBadge field="tempo" value={model.fieldStatus.tempo} compact />
             </div>
             <ScrollArea className="flex-1">
               {isFieldUsable(model.fieldStatus.tempo) && model.tempoMap.length > 0 ? (
                 <Table>
                   <TableHeader className="bg-transparent sticky top-0 backdrop-blur-md">
                     <TableRow className="hover:bg-transparent">
                       <TableHead className="w-[100px]">Time</TableHead>
                       <TableHead>BPM</TableHead>
                       <TableHead className="text-right">Confidence</TableHead>
                     </TableRow>
                   </TableHeader>
                   <TableBody>
                     {model.tempoMap.map((t, idx) => (
                       <TableRow key={`tempo-${idx}`} data-testid={`row-tempo-${idx}`}>
                         <TableCell className="font-mono text-xs text-muted-foreground">{formatTime(t.time)}</TableCell>
                         <TableCell className="font-mono font-medium text-xs">{Math.round(t.bpm * 10) / 10}</TableCell>
                         <TableCell className="text-right">
                           <ConfidenceScore value={t.confidence} />
                         </TableCell>
                       </TableRow>
                     ))}
                   </TableBody>
                 </Table>
               ) : (
                  <div className="p-8 text-center text-sm text-muted-foreground italic" data-testid="text-no-tempo">
                    {fieldEmptyMessage(model.fieldStatus.tempo, "No tempo events were detected.")}
                  </div>
               )}
             </ScrollArea>
          </div>

          <div className="flex-1 border rounded-md bg-card overflow-hidden flex flex-col">
             <div className="px-4 py-2 border-b bg-muted/20 font-semibold text-xs flex items-center gap-2">
               <Hash className="h-4 w-4" /> Meter Events
               <FieldStatusBadge field="meter" value={model.fieldStatus.meter} compact />
             </div>
             <ScrollArea className="flex-1">
               {isFieldUsable(model.fieldStatus.meter) && model.meterMap.length > 0 ? (
                 <Table>
                   <TableHeader className="bg-transparent sticky top-0 backdrop-blur-md">
                     <TableRow className="hover:bg-transparent">
                       <TableHead className="w-[100px]">Bar</TableHead>
                       <TableHead>Signature</TableHead>
                       <TableHead className="text-right">Confidence</TableHead>
                     </TableRow>
                   </TableHeader>
                   <TableBody>
                     {model.meterMap.map((m, idx) => (
                       <TableRow key={`meter-${idx}`} data-testid={`row-meter-${idx}`}>
                         <TableCell className="font-mono text-xs text-muted-foreground">{m.bar}</TableCell>
                         <TableCell className="font-mono font-medium text-xs bg-muted/30 rounded inline-block px-1.5 py-0.5 mt-2">{m.meter}</TableCell>
                         <TableCell className="text-right">
                           <ConfidenceScore value={m.confidence} />
                         </TableCell>
                       </TableRow>
                     ))}
                   </TableBody>
                 </Table>
               ) : (
                  <div className="p-8 text-center text-sm text-muted-foreground italic" data-testid="text-no-meter">
                    {fieldEmptyMessage(model.fieldStatus.meter, "No meter events were detected.")}
                  </div>
               )}
             </ScrollArea>
          </div>
        </TabsContent>

        <TabsContent value="harmony" className="flex-1 min-h-0 overflow-hidden m-0 pt-4 flex gap-4">
           <div className="flex-[0.4] border rounded-md bg-card overflow-hidden flex flex-col">
             <div className="px-4 py-2 border-b bg-muted/20 font-semibold text-xs flex items-center gap-2">
                Key Map
                <FieldStatusBadge field="key" value={model.fieldStatus.key} compact />
             </div>
             <ScrollArea className="flex-1">
                {isFieldUsable(model.fieldStatus.key) && model.keyMap.length > 0 ? (
                 <Table>
                   <TableHeader className="bg-transparent sticky top-0 backdrop-blur-md">
                     <TableRow className="hover:bg-transparent">
                       <TableHead className="w-[80px]">Time</TableHead>
                       <TableHead>Key</TableHead>
                       <TableHead className="text-right">Conf</TableHead>
                     </TableRow>
                   </TableHeader>
                   <TableBody>
                     {model.keyMap.map((k, idx) => (
                       <TableRow key={`key-${idx}`} data-testid={`row-key-${idx}`}>
                         <TableCell className="font-mono text-xs text-muted-foreground">{formatTime(k.time)}</TableCell>
                         <TableCell className="font-semibold text-xs text-primary">{k.key}</TableCell>
                         <TableCell className="text-right">
                           <ConfidenceScore value={k.confidence} hideBar />
                         </TableCell>
                       </TableRow>
                     ))}
                   </TableBody>
                 </Table>
               ) : (
                  <div className="p-8 text-center text-sm text-muted-foreground italic" data-testid="text-no-key">
                    {fieldEmptyMessage(model.fieldStatus.key, "No key events were detected.")}
                  </div>
               )}
             </ScrollArea>
          </div>

          <div className="flex-1 border rounded-md bg-card overflow-hidden flex flex-col">
             <div className="px-4 py-2 border-b bg-muted/20 font-semibold text-xs flex items-center gap-2">
                Chord Progressions
                <FieldStatusBadge field="harmony" value={model.fieldStatus.harmony} compact />
             </div>
             <ScrollArea className="flex-1">
                {isFieldUsable(model.fieldStatus.harmony) && model.chords.length > 0 ? (
                 <Table>
                   <TableHeader className="bg-transparent sticky top-0 backdrop-blur-md">
                     <TableRow className="hover:bg-transparent">
                       <TableHead className="w-[140px]">Time Range</TableHead>
                       <TableHead>Symbol</TableHead>
                       <TableHead>Roman</TableHead>
                       <TableHead className="text-right">Confidence</TableHead>
                     </TableRow>
                   </TableHeader>
                   <TableBody>
                     {model.chords.map((c, idx) => (
                       <TableRow key={`chord-${idx}`} data-testid={`row-chord-${idx}`}>
                         <TableCell className="font-mono text-xs text-muted-foreground">
                           {formatTime(c.start)} - {formatTime(c.end)}
                         </TableCell>
                         <TableCell className="font-mono font-semibold text-xs">
                           <span className="bg-secondary px-2 py-0.5 rounded border shadow-sm">{c.symbol}</span>
                         </TableCell>
                         <TableCell className="font-serif text-xs italic">{c.roman}</TableCell>
                         <TableCell className="text-right">
                           <ConfidenceScore value={c.confidence} />
                         </TableCell>
                       </TableRow>
                     ))}
                   </TableBody>
                 </Table>
               ) : (
                  <div className="p-8 text-center text-sm text-muted-foreground italic" data-testid="text-no-chords">
                    {fieldEmptyMessage(model.fieldStatus.harmony, "No chord events were detected.")}
                  </div>
               )}
             </ScrollArea>
          </div>
        </TabsContent>

        <TabsContent value="melody" className="flex-1 min-h-0 overflow-hidden m-0 pt-4">
           <div className="h-full border rounded-md bg-card overflow-hidden flex flex-col">
             <div className="px-4 py-2 border-b bg-muted/20 font-semibold text-xs flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Music2 className="h-4 w-4" /> Note Events
                  <FieldStatusBadge field="melody" value={model.fieldStatus.melody} compact />
                </div>
               <Badge variant="outline" className="font-mono text-[10px]">
                 Total: {model.melody.length}
               </Badge>
             </div>
             <ScrollArea className="flex-1">
                {isFieldUsable(model.fieldStatus.melody) && model.melody.length > 0 ? (
                 <Table>
                   <TableHeader className="bg-transparent sticky top-0 backdrop-blur-md">
                     <TableRow className="hover:bg-transparent">
                       <TableHead className="w-[140px]">Time Range</TableHead>
                       <TableHead>Pitch</TableHead>
                       <TableHead>Velocity</TableHead>
                       <TableHead>Source</TableHead>
                       <TableHead className="text-right">Confidence</TableHead>
                     </TableRow>
                   </TableHeader>
                   <TableBody>
                     {model.melody.map((n, idx) => (
                       <TableRow key={`note-${idx}`} data-testid={`row-note-${idx}`}>
                         <TableCell className="font-mono text-xs text-muted-foreground">
                           {formatTime(n.start)} - {formatTime(n.end)}
                         </TableCell>
                         <TableCell className="font-mono text-xs font-semibold">{midiToNote(n.pitch)} ({n.pitch})</TableCell>
                         <TableCell>
                           <div className="flex items-center gap-2 max-w-[80px]">
                             <span className="font-mono text-[10px] w-6">{n.velocity}</span>
                             <Progress value={(n.velocity / 127) * 100} className="h-1.5 bg-muted/50" />
                           </div>
                         </TableCell>
                         <TableCell>
                           <Badge variant="secondary" className="text-[9px] uppercase tracking-wider">{n.source}</Badge>
                         </TableCell>
                         <TableCell className="text-right">
                           <ConfidenceScore value={n.confidence} />
                         </TableCell>
                       </TableRow>
                     ))}
                   </TableBody>
                 </Table>
               ) : (
                 <div className="flex flex-col items-center justify-center h-48 text-muted-foreground space-y-2">
                    <AlertCircle className="h-6 w-6 text-yellow-500/80" />
                     <p className="text-sm font-medium">
                       {fieldEmptyMessage(model.fieldStatus.melody, "No melodic line was detected.")}
                     </p>
                    <p className="text-xs text-center max-w-xs">
                      If the track is instrumental or percussive, this is normal. Otherwise, the analysis may have failed.
                    </p>
                 </div>
               )}
             </ScrollArea>
           </div>
        </TabsContent>

        <TabsContent value="sections" className="flex-1 min-h-0 overflow-hidden m-0 pt-4">
           <div className="h-full border rounded-md bg-card overflow-hidden flex flex-col">
              <div className="px-4 py-2 border-b bg-muted/20 font-semibold text-xs flex items-center gap-2">
                <FileType2 className="h-4 w-4" /> Structural Boundaries
                <FieldStatusBadge field="sections" value={model.fieldStatus.sections} compact />
             </div>
             <ScrollArea className="flex-1">
                {isFieldUsable(model.fieldStatus.sections) && model.sections.length > 0 ? (
                 <Table>
                   <TableHeader className="bg-transparent sticky top-0 backdrop-blur-md">
                     <TableRow className="hover:bg-transparent">
                       <TableHead>Section Label</TableHead>
                       <TableHead className="w-[120px]">Bar Range</TableHead>
                       <TableHead className="w-[200px]">Energy</TableHead>
                     </TableRow>
                   </TableHeader>
                   <TableBody>
                     {model.sections.map((s, idx) => (
                       <TableRow key={`section-${idx}`} data-testid={`row-section-${idx}`}>
                         <TableCell className="font-bold text-xs capitalize tracking-wide">{s.name}</TableCell>
                         <TableCell className="font-mono text-xs text-muted-foreground">
                           {s.startBar} &rarr; {s.endBar}
                         </TableCell>
                         <TableCell>
                           <div className="flex items-center gap-2">
                             <span className="font-mono text-[10px] w-6">{Math.round(s.energy * 100)}%</span>
                             <Progress value={s.energy * 100} className="h-1.5 bg-muted/50" />
                           </div>
                         </TableCell>
                       </TableRow>
                     ))}
                   </TableBody>
                 </Table>
               ) : (
                  <div className="p-8 text-center text-sm text-muted-foreground italic" data-testid="text-no-sections">
                    {fieldEmptyMessage(model.fieldStatus.sections, "No structural sections were detected.")}
                  </div>
               )}
             </ScrollArea>
           </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

const songModelFields = [
  "tempo",
  "meter",
  "key",
  "melody",
  "harmony",
  "sections",
  "energy",
] as const;

function ConfidenceScore({ value, hideBar = false }: { value: number, hideBar?: boolean }) {
  const percentage = Math.round(value * 100);
  const colorClass = value > 0.8 ? "text-emerald-500" : value > 0.5 ? "text-yellow-500" : "text-red-500 bg-red-500/10 px-1 rounded";
  const progressClass = value > 0.8 ? "bg-emerald-500" : value > 0.5 ? "bg-yellow-500" : "bg-red-500";

  return (
    <div className="flex flex-col items-end gap-1">
      <span className={cn("font-mono text-[10px] font-medium", colorClass)}>
        {percentage}%
      </span>
      {!hideBar && (
        <div className="h-1 w-12 bg-muted/50 rounded-full overflow-hidden">
          <div className={cn("h-full rounded-full", progressClass)} style={{ width: `${percentage}%` }} />
        </div>
      )}
    </div>
  );
}

function AnalysisActivity({
  jobs,
  retrying,
  onRetry,
}: {
  jobs?: Array<{
    id: string;
    sourceId: string;
    status: string;
    stage: string;
    progress: number;
    attempt: number;
    error: string | null;
    startedAt: string | null;
  }>;
  retrying: boolean;
  onRetry: (sourceId: string) => void;
}) {
  if (!jobs?.length) return null;
  return (
    <Card data-testid="analysis-activity">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <Activity className="h-3.5 w-3.5" />
          Analysis activity
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-4 pt-0">
        {jobs.map((job) => (
          <div key={job.id} className="rounded border bg-muted/10 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {job.status === "running" && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                {job.status === "completed" && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                {job.status === "failed" && <AlertTriangle className="h-4 w-4 text-destructive" />}
                {job.status === "queued" && <Timer className="h-4 w-4 text-muted-foreground" />}
                <span className="text-xs font-medium">{job.stage || "Analysis job"}</span>
                <Badge variant="outline" className="h-5 text-[9px]">{job.status}</Badge>
              </div>
              <span className="font-mono text-[10px] text-muted-foreground">
                Attempt {job.attempt}
                {job.startedAt ? ` · ${new Date(job.startedAt).toLocaleTimeString()}` : ""}
              </span>
            </div>
            {(job.status === "running" || job.status === "queued") && (
              <Progress value={job.progress} className="mt-2 h-1.5" />
            )}
            {job.status === "failed" && (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded bg-destructive/5 p-2">
                <p className="text-xs text-destructive">{job.error || "Analysis failed."}</p>
                <Button size="sm" variant="outline" onClick={() => onRetry(job.sourceId)} disabled={retrying}>
                  <RefreshCw className={cn("mr-2 h-3.5 w-3.5", retrying && "animate-spin")} />
                  Retry analysis
                </Button>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SourceAnalysisState({
  source,
  accessDenied = false,
}: {
  source?: ProjectSource;
  accessDenied?: boolean;
}) {
  const isFailed = source?.status === "failed";
  const isProcessing = source && ["queued", "preprocessing", "analyzing"].includes(source.status);
  const title = accessDenied
    ? "Log in to inspect this Song Model"
    : isFailed
    ? "Source analysis failed"
    : isProcessing
      ? "Song Model is still being built"
      : source?.status === "ready"
        ? "Song Model record is unavailable"
        : "No Song Model exists yet";
  const detail = accessDenied
    ? "This project contains protected source analysis owned by another session."
    : isFailed
    ? source.error || "The analyzer did not return a usable model."
    : isProcessing
      ? `${source.progress}% complete · ${source.name}`
      : source?.status === "ready"
        ? "The source completed, but no canonical model response was found."
        : "Import a real source recording to create an inspectable model.";

  return (
    <div
      className="flex h-full flex-col items-center justify-center space-y-4 p-8 text-center text-muted-foreground"
      data-testid="song-model-unavailable"
    >
      {isProcessing && !accessDenied ? (
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      ) : (
        <AlertCircle className={cn("h-8 w-8", isFailed ? "text-destructive" : "text-amber-600")} />
      )}
      <div>
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mt-1 max-w-md text-xs">{detail}</p>
      </div>
      {source && (
        <div className="grid min-w-72 grid-cols-2 gap-x-4 gap-y-1 rounded-md border bg-card p-3 text-left text-xs">
          <span>Source</span>
          <span className="truncate text-right font-mono">{source.name}</span>
          <span>Status</span>
          <span className="text-right font-mono">{source.status}</span>
          <span>Format</span>
          <span className="text-right font-mono">{source.contentType}</span>
          <span>Size</span>
          <span className="text-right font-mono">{formatBytes(source.size)}</span>
        </div>
      )}
      <p className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800">
        No seed or placeholder analysis values are shown.
      </p>
    </div>
  );
}

function FieldStatusBadge({
  field,
  value,
  compact = false,
}: {
  field: string;
  value?: SongModelFieldStatusProperty;
  compact?: boolean;
}) {
  const status = value?.status ?? "not_available";
  const label = value?.edited
    ? "User edit"
    : status === "detected"
      ? "Detected"
      : status === "low_confidence"
        ? "Low confidence"
        : status === "failed"
          ? "Failed"
          : "Not available";
  const className = value?.edited
    ? "border-violet-500/30 bg-violet-500/10 text-violet-700"
    : status === "detected"
      ? "border-sky-500/30 bg-sky-500/10 text-sky-700"
      : status === "low_confidence"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700"
        : "border-red-500/30 bg-red-500/10 text-red-700";
  const providers = value?.providers.length ? value.providers.join(", ") : "No provider";
  const confidence = value?.confidence == null ? "" : ` · ${Math.round(value.confidence * 100)}%`;

  return (
    <Badge
      variant="outline"
      className={cn("font-mono font-normal", compact ? "ml-auto px-1.5 py-0 text-[9px]" : "text-[10px]", className)}
      title={`${field}: ${providers}${confidence}${value?.message ? ` · ${value.message}` : ""}`}
      data-testid={`status-field-${field}`}
    >
      {compact ? label : `${field}: ${label}${confidence}`}
    </Badge>
  );
}

function isFieldUsable(value?: SongModelFieldStatusProperty): boolean {
  return value?.status !== "failed" && value?.status !== "not_available";
}

function fieldEmptyMessage(value: SongModelFieldStatusProperty | undefined, fallback: string): string {
  return value?.message || fallback;
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  return typeof error.status === "number" ? error.status : null;
}

function formatTime(seconds: number): string {
  if (isNaN(seconds)) return "0:00.0";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m}:${s.toString().padStart(2, '0')}.${ms}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiToNote(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  const note = noteNames[midi % 12];
  return `${note}${octave}`;
}
