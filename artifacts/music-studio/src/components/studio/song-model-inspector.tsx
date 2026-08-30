import { useEffect, useRef } from "react";
import { 
  useGetProjectSongModel, 
  useListAnalysisJobs, 
  useRetrySourceAnalysis, 
  useListMusicProviders,
  getListAnalysisJobsQueryKey,
  getGetProjectSongModelQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { 
  Activity, AlertTriangle, CheckCircle2, Cpu, Database, Layers, 
  Mic, Music, RefreshCw, Server, Shield, Timer, Workflow, Loader2 
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty";

function formatDuration(seconds: number) {
  if (!seconds) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function SongModelInspector({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const refreshedCompletedJobRef = useRef<string | null>(null);
  const { data: jobs, isLoading: isJobsLoading } = useListAnalysisJobs(projectId, {
    query: {
      queryKey: getListAnalysisJobsQueryKey(projectId),
      refetchInterval: (query) => {
        const hasActive = query.state.data?.some(j => j.status === 'running' || j.status === 'queued');
        return hasActive ? 2000 : false;
      }
    }
  });
  
  const hasActiveJob = jobs?.some(job => job.status === "running" || job.status === "queued") ?? false;
  const { data: model, isLoading: isModelLoading } = useGetProjectSongModel(projectId, {
    query: {
      queryKey: getGetProjectSongModelQueryKey(projectId),
      retry: false,
      refetchInterval: hasActiveJob ? 2_000 : false,
    }
  });

  const { data: providers } = useListMusicProviders();
  const retry = useRetrySourceAnalysis();

  useEffect(() => {
    const latestCompleted = jobs?.find(job => job.status === "completed");
    if (latestCompleted && refreshedCompletedJobRef.current !== latestCompleted.id) {
      refreshedCompletedJobRef.current = latestCompleted.id;
      void queryClient.invalidateQueries({
        queryKey: getGetProjectSongModelQueryKey(projectId),
      });
    }
  }, [jobs, projectId, queryClient]);

  const handleRetry = (sourceId: string) => {
    retry.mutate({ projectId, sourceId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAnalysisJobsQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectSongModelQueryKey(projectId) });
      }
    });
  };

  const activeProviderDetails = providers?.filter(p => model?.providers?.includes(p.id)) || [];
  
  if (isJobsLoading || isModelLoading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-muted-foreground gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <p className="text-sm font-mono">Retrieving analysis data...</p>
      </div>
    );
  }

  if (!jobs?.length && !model) {
    return (
      <div className="pt-12">
        <EmptyState 
          icon={Database} 
          title="No Analysis Data" 
          description="Upload a source track to begin musical analysis and build a Song Model."
        />
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500 pb-12">
      
      {/* Analysis Activity */}
      {jobs && jobs.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2 border-b pb-2">
            <Activity className="h-4 w-4" /> Analysis Activity
          </h3>
          <div className="grid gap-3">
            {jobs.map(job => (
              <Card key={job.id} className={cn("overflow-hidden transition-all", job.status === 'failed' ? 'border-destructive/50 shadow-sm shadow-destructive/10' : 'bg-muted/10')}>
                <div className="p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {job.status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                      {job.status === 'completed' && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                      {job.status === 'failed' && <AlertTriangle className="h-4 w-4 text-destructive" />}
                      {job.status === 'queued' && <Timer className="h-4 w-4 text-muted-foreground" />}
                      <span className="font-semibold text-sm">
                        {job.stage ? `Stage: ${job.stage}` : 'Analysis Job'} 
                      </span>
                      <Badge variant={job.status === 'failed' ? 'destructive' : job.status === 'completed' ? 'outline' : 'secondary'} className="text-[10px] font-mono py-0 h-5">
                        {job.status}
                      </Badge>
                    </div>
                    <div className="text-xs font-mono text-muted-foreground flex gap-4">
                      {job.startedAt && <span>{format(new Date(job.startedAt), 'HH:mm:ss')}</span>}
                      <span>Attempt {job.attempt || 1}</span>
                    </div>
                  </div>
                  
                  {(job.status === 'running' || job.status === 'queued') && (
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
                        <span>Progress</span>
                        <span>{job.progress}%</span>
                      </div>
                      <Progress value={job.progress} className="h-1.5 bg-primary/10" />
                    </div>
                  )}

                  {job.status === 'failed' && (
                    <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md border border-destructive/20 flex flex-col gap-3 mt-1">
                      <p className="font-mono text-xs">{job.error || "An unknown error occurred during analysis."}</p>
                      <Button 
                        size="sm" 
                        variant="outline" 
                        className="self-start border-destructive/30 hover:bg-destructive/20 hover:text-destructive h-8 text-xs"
                        onClick={() => handleRetry(job.sourceId)}
                        disabled={retry.isPending}
                      >
                        {retry.isPending ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-2" />}
                        Retry Analysis
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* The Model */}
      {model && (
        <div className="space-y-6">
          <div className="flex items-center gap-2 border-b pb-2">
            <Database className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-bold">Song Model Details</h2>
            <Badge variant="outline" className="ml-auto font-mono text-muted-foreground">{model.version ? `v${model.version}` : 'v1'}</Badge>
          </div>

          {/* Identity & Audio */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="shadow-sm border-t-2 border-t-primary/50 bg-card/50 backdrop-blur">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
                  <Mic className="h-4 w-4" /> Source DNA
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-y-4 gap-x-2">
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Duration</div>
                    <div className="font-mono text-sm">{formatDuration(model.audio?.durationSeconds || 0)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Sample Rate</div>
                    <div className="font-mono text-sm">{(model.audio?.sampleRate ? model.audio.sampleRate / 1000 : 0).toFixed(1)} kHz</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Channels</div>
                    <div className="font-mono text-sm">{model.audio?.channels === 2 ? 'Stereo' : model.audio?.channels === 1 ? 'Mono' : (model.audio?.channels || 'Unknown')}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Size</div>
                    <div className="font-mono text-sm">{(model.audio?.size ? model.audio.size / (1024 * 1024) : 0).toFixed(1)} MB</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-sm border-t-2 border-t-emerald-500/50 bg-card/50 backdrop-blur">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
                  <Music className="h-4 w-4" /> Derived Features
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-y-4 gap-x-2">
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Dominant Key</div>
                    <div className="font-mono text-sm font-semibold">{model.keyMap?.[0]?.key || "Unknown"}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Tempo</div>
                    <div className="font-mono text-sm font-semibold">{model.tempoMap?.[0]?.bpm ? Math.round(model.tempoMap[0].bpm) : "Unknown"} BPM</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Meter</div>
                    <div className="font-mono text-sm font-semibold">{model.meterMap?.[0]?.meter || "4/4"}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Structure</div>
                    <div className="font-mono text-sm font-semibold">{model.sections?.length || 0} Sections</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Raw Insights Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard title="Total Beats" value={model.beats?.length || 0} icon={Activity} />
            <StatCard title="Total Bars" value={model.bars?.length || 0} icon={Workflow} />
            <StatCard title="Chord Changes" value={model.chords?.length || 0} icon={Music} />
            <StatCard title="Melodic Notes" value={model.melody?.length || 0} icon={Activity} />
          </div>

          {/* Confidence & Providers Matrix */}
          <Card className="shadow-sm overflow-hidden">
            <CardHeader className="pb-3 bg-muted/20 border-b">
              <CardTitle className="text-sm flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Shield className="h-4 w-4 text-primary" /> Confidence & Provenance
                </div>
                <Badge className="bg-primary/10 text-primary hover:bg-primary/20 font-mono shadow-sm border-primary/20">
                  {Math.round((model.confidence || 0) * 100)}% Quality
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="space-y-8">
                
                {/* Capability Matrix */}
                {model.provenance && model.provenance.length > 0 && (
                  <div>
                    <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-4">Model Capabilities</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                      {model.provenance.map(prov => {
                        const conf = model.confidenceByField?.[prov.capability] || 0;
                        return (
                          <div key={prov.capability} className="bg-muted/20 p-3 rounded-lg border border-border/50 flex flex-col gap-2 hover:border-primary/30 transition-colors">
                            <div className="flex justify-between items-start">
                              <span className="text-sm font-medium capitalize">{prov.capability.replace(/_/g, ' ').toLowerCase()}</span>
                              <Badge variant="outline" className={cn("text-[9px] py-0 h-4 px-1.5 font-mono shadow-sm", 
                                prov.status === 'ready' ? 'bg-primary/10 text-primary border-primary/20' : 'bg-muted text-muted-foreground'
                              )}>
                                {prov.status}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono">
                              <Cpu className="h-3 w-3" />
                              <span className="truncate">{prov.provider}</span>
                              {prov.version && <span className="opacity-60">v{prov.version}</span>}
                            </div>
                            <div className="mt-1 space-y-1.5">
                              <div className="flex justify-between text-[9px] font-mono text-muted-foreground">
                                <span>CONFIDENCE</span>
                                <span>{Math.round(conf * 100)}%</span>
                              </div>
                              <div className="h-1 w-full bg-muted rounded-full overflow-hidden">
                                <div className="h-full bg-primary" style={{ width: `${conf * 100}%` }} />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Engine Roster */}
                {activeProviderDetails.length > 0 && (
                  <div>
                    <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-4 flex items-center gap-2">
                      <Server className="h-3.5 w-3.5" /> Engine Roster
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {activeProviderDetails.map(provider => (
                        <div key={provider.id} className="border border-border/50 bg-muted/10 p-3 rounded-lg flex flex-col gap-1.5 hover:border-primary/30 transition-colors">
                           <div className="flex justify-between items-start">
                             <span className="font-semibold text-sm">{provider.name}</span>
                             <Badge variant="outline" className="text-[9px] h-4 py-0 font-mono bg-background shadow-sm">{provider.execution}</Badge>
                           </div>
                           <div className="text-[10px] text-muted-foreground font-mono">v{provider.version} · {provider.provider}</div>
                           <div className="flex flex-wrap gap-1 mt-1.5">
                             {provider.capabilities?.map(cap => (
                               <span key={cap} className="text-[9px] bg-background border px-1.5 py-0.5 rounded text-muted-foreground uppercase tracking-wider">
                                 {cap.replace(/_/g, ' ')}
                               </span>
                             ))}
                           </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Extracted Stems */}
                {model.sourceStems && model.sourceStems.length > 0 && (
                  <div>
                    <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-4 flex items-center gap-2">
                      <Layers className="h-3.5 w-3.5" /> Source Stems
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {model.sourceStems.map((stem, i) => (
                        <div key={i} className="flex items-center gap-2 bg-background border border-border/60 pl-3 pr-1.5 py-1.5 rounded-full text-sm shadow-sm hover:border-primary/40 transition-colors">
                          <span className="font-semibold text-xs capitalize">{stem.role}</span>
                          <span className="text-[10px] font-mono text-muted-foreground border-l pl-2 py-0.5">{stem.provider}</span>
                          <Badge variant="secondary" className="text-[10px] font-mono bg-primary/10 text-primary py-0 h-5 px-1.5 border-primary/20">
                            {Math.round(stem.confidence * 100)}%
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function StatCard({ title, value, icon: Icon }: { title: string, value: number, icon: any }) {
  return (
    <div className="bg-card/50 backdrop-blur border border-border/60 rounded-lg p-5 flex flex-col items-center justify-center text-center gap-2 shadow-sm hover:border-primary/40 transition-colors">
      <Icon className="h-5 w-5 text-muted-foreground opacity-50 mb-1" />
      <div className="text-2xl font-bold font-mono text-foreground tracking-tight">{value}</div>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">{title}</div>
    </div>
  )
}
