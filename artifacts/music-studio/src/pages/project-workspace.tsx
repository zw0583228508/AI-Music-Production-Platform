import { useState, useRef, useEffect } from "react";
import { useRoute } from "wouter";
import { 
  useGetProject, 
  useListArrangements, 
  useCreateArrangement,
  useGenerateArrangement,
  useUpdateArrangement,
  useListTracks,
  useListArtifacts,
  useRunCopilot,
  useCreateProjectExport,
  getListArtifactsQueryKey,
  ExportResult,
  GenerationResult,
  ArrangementMode,
  ArrangementStatus,
  Arrangement
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
  Loader2
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
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { SourceImport } from "@/components/studio/source-import";
import { SongModelInspector } from "@/components/studio/song-model-inspector";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function ProjectWorkspace() {
  const [, params] = useRoute("/projects/:projectId");
  const projectId = params?.projectId || "";
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: workspace, isLoading, error } = useGetProject(projectId);
  const { data: arrangements } = useListArrangements(projectId);
  const { data: tracks } = useListTracks(projectId);
  const { data: artifacts } = useListArtifacts(projectId);
  
  const createArrangement = useCreateArrangement();
  const updateArrangement = useUpdateArrangement();
  const generateArrangement = useGenerateArrangement();
  const createExport = useCreateProjectExport();
  // const runCopilot = useRunCopilot(); // We'll mock copilot if it's not exported, but let's assume it is

  const [activeTab, setActiveTab] = useState("model");
  const [selectedArrangementId, setSelectedArrangementId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [includeStems, setIncludeStems] = useState(true);
  const [includeMidi, setIncludeMidi] = useState(true);
  const [masterProfile, setMasterProfile] = useState("STREAMING");
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [generationResult, setGenerationResult] = useState<GenerationResult | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);

  const [copilotCommand, setCopilotCommand] = useState("");
  const runCopilot = useRunCopilot();
  const [copilotMessages, setCopilotMessages] = useState<Array<{role: 'user'|'assistant', text: string, operations?: any[]}>>([
    { role: 'assistant', text: "Hi! I'm your studio assistant. I can help analyze the track, tweak arrangement parameters, or suggest structural changes. What would you like to do?" }
  ]);

  // Sync selected arrangement
  useEffect(() => {
    if (arrangements?.length && !selectedArrangementId) {
      setSelectedArrangementId(arrangements[0].id);
    }
  }, [arrangements, selectedArrangementId]);

  const activeArrangement = arrangements?.find(a => a.id === selectedArrangementId);

  // Auto-save logic for arrangement parameters
  const [localHarmony, setLocalHarmony] = useState<number>(5);
  const [localEnergy, setLocalEnergy] = useState<number>(0.5);
  const [localDensity, setLocalDensity] = useState<number>(0.5);
  
  const initializedArrangementRef = useRef<string | null>(null);
  
  useEffect(() => {
    if (activeArrangement && initializedArrangementRef.current !== activeArrangement.id) {
      initializedArrangementRef.current = activeArrangement.id;
      setLocalHarmony(activeArrangement.harmonyComplexity);
      setLocalEnergy(activeArrangement.energy);
      setLocalDensity(activeArrangement.density);
      setSelectedCandidateId(activeArrangement.selectedCandidateId);
    }
  }, [activeArrangement]);

  const handleParamChange = (param: string, value: number) => {
    if (!activeArrangement) return;
    
    if (param === 'harmony') setLocalHarmony(value);
    if (param === 'energy') setLocalEnergy(value);
    if (param === 'density') setLocalDensity(value);

    // Optimistic UI + debounce server update (simplified immediate for now)
    updateArrangement.mutate({
      arrangementId: activeArrangement.id,
      data: {
        [param === 'harmony' ? 'harmonyComplexity' : param]: value
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListArrangementsQueryKey(projectId) });
      }
    });
  };

  const handleGenerate = () => {
    if (!activeArrangement) return;
    generateArrangement.mutate({
      arrangementId: activeArrangement.id,
      data: { candidates: 3 }
    }, {
      onSuccess: (result) => {
        setGenerationResult(result);
        setSelectedCandidateId(result.selectedCandidate);
        setActiveTab("candidates");
        toast({
          title: "Arrangement candidates ready",
          description: `${result.candidates.length} candidates generated by ${result.provider.name}.`,
        });
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
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
    setExportResult(null);
    createExport.mutate({
      projectId,
      data: {
        arrangementId: activeArrangement.id,
        includeStems,
        includeMidi,
        includeMix: true,
        includeMetadata: true,
        masterProfile: masterProfile as "STREAMING" | "DYNAMIC" | "CLASSICAL" | "POP" | "LOUD" | "FILM",
      },
    }, {
      onSuccess: (result) => {
        setExportResult({
          id: result.id,
          status: result.status,
          files: result.files,
          bundleUrl: result.url,
          createdAt: result.createdAt,
        });
        queryClient.invalidateQueries({ queryKey: getListArtifactsQueryKey(projectId) });
        toast({
          title: "Export package ready",
          description: `${result.files.length} playable files were rendered and saved.`,
        });
        downloadFile(result.url);
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
    if (!copilotCommand.trim() || runCopilot.isPending) return;

    const command = copilotCommand;
    setCopilotMessages(prev => [...prev, { role: 'user', text: command }]);
    setCopilotCommand("");

    runCopilot.mutate({
      projectId,
      data: { command }
    }, {
      onSuccess: (res) => {
        setCopilotMessages(prev => [...prev, { 
          role: 'assistant', 
          text: res.reply,
          operations: res.operations
        }]);
        // Also refresh arrangement / project data just in case copilot changed something!
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getListArrangementsQueryKey(projectId) });
      },
      onError: () => {
        toast({ title: "Copilot Error", description: "Failed to process command", variant: "destructive" });
      }
    });
  };

  if (isLoading) {
    return <div className="p-10 flex items-center justify-center min-h-screen text-muted-foreground"><Activity className="animate-pulse mr-2" /> Loading workspace...</div>;
  }

  if (error || !workspace) {
    return <div className="p-10 text-destructive text-center font-bold">Project not found or error loading workspace.</div>;
  }

  const { project, analysis } = workspace;
  const visibleCandidates = generationResult && generationResult.arrangement.id === activeArrangement?.id
    ? generationResult.candidates
    : activeArrangement?.candidates ?? [];
  const visibleProvider = generationResult && generationResult.arrangement.id === activeArrangement?.id
    ? generationResult.provider.name
    : activeArrangement?.generationProvider;

  return (
    <div className="flex flex-col h-full bg-background relative overflow-hidden">
      {/* Top Header / Transport */}
      <header className="h-16 border-b bg-card flex items-center justify-between px-6 shrink-0 shadow-sm z-10 relative">
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
            {analysis?.meter || "4/4"}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <SourceImport
            projectId={projectId}
            sourceType={project.sourceType}
            onReady={() => {
              void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
              void queryClient.invalidateQueries({ queryKey: getListArtifactsQueryKey(projectId) });
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
      </header>

      {/* Main Workspace Area */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        
        {/* Left Panel: Tracks */}
        <aside className="w-64 border-r bg-sidebar flex flex-col shrink-0 z-10 shadow-[2px_0_10px_rgba(0,0,0,0.02)]">
          <div className="h-12 border-b flex items-center px-4 justify-between bg-sidebar-accent/30 font-semibold text-sm">
            <div className="flex items-center gap-2">
              <ListMusic className="h-4 w-4 text-primary" />
              Tracks
            </div>
            <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full"><Plus className="h-3.5 w-3.5" /></Button>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {tracks?.map(track => (
                <div key={track.id} className="flex items-center gap-3 p-2 rounded-md hover:bg-sidebar-accent/50 group text-sm border border-transparent hover:border-sidebar-border transition-all">
                  <div className="w-2 h-2 rounded-full shrink-0 shadow-sm" style={{ backgroundColor: track.color || 'hsl(var(--primary))' }} />
                  <div className="flex-1 truncate font-medium">{track.name}</div>
                  <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity gap-1">
                    <button className={cn("h-5 w-5 rounded flex items-center justify-center text-[10px] font-bold border", track.muted ? "bg-red-500/10 text-red-500 border-red-500/20" : "bg-muted text-muted-foreground hover:bg-background")}>M</button>
                    <button className={cn("h-5 w-5 rounded flex items-center justify-center text-[10px] font-bold border", track.solo ? "bg-yellow-500/10 text-yellow-600 border-yellow-500/20" : "bg-muted text-muted-foreground hover:bg-background")}>S</button>
                  </div>
                </div>
              ))}
              {!tracks?.length && (
                <div className="text-center p-4 text-xs text-muted-foreground italic">No tracks generated yet.</div>
              )}
            </div>
          </ScrollArea>
        </aside>

        {/* Center Panel: Arrangement & Timeline */}
        <main className="flex-1 flex flex-col min-w-0 bg-background z-0 relative">
          {/* Analysis Timeline Strip */}
          <div className="h-32 border-b bg-card p-4 shrink-0 flex flex-col relative overflow-hidden">
            <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, black 1px, transparent 0)', backgroundSize: '16px 16px' }} />
            <div className="flex items-center justify-between mb-2 relative z-10">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5" />
                Structure Map
              </h3>
            </div>
            
            {/* Mock Timeline UI */}
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

          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
            <div className="px-6 pt-4 shrink-0">
              <TabsList className="grid w-full max-w-md grid-cols-3">
                <TabsTrigger value="model">Song Model</TabsTrigger>
                <TabsTrigger value="arrangement">Director</TabsTrigger>
                <TabsTrigger value="candidates">Candidates</TabsTrigger>
              </TabsList>
            </div>

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
                          />
                          <p className="text-xs text-muted-foreground">Number of simultaneous parts and textural thickness.</p>
                        </div>
                      </CardContent>
                    </Card>
                    
                    <div className="flex justify-end">
                      <Button 
                        size="lg" 
                        onClick={handleGenerate} 
                        disabled={activeArrangement.status === 'generating'}
                        className="shadow-md shadow-primary/20 text-md px-8"
                      >
                        {activeArrangement.status === 'generating' ? (
                          <><Activity className="mr-2 h-5 w-5 animate-pulse" /> Generating...</>
                        ) : (
                          <><Wand2 className="mr-2 h-5 w-5" /> Generate Variations</>
                        )}
                      </Button>
                    </div>
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

            <TabsContent value="candidates" className="flex-1 m-0 p-6 min-h-0 overflow-auto">
               <div className="max-w-3xl mx-auto">
                 <h2 className="text-xl font-bold mb-6">Generated Candidates</h2>
                 {visibleCandidates.length > 0 ? (
                   <div className="space-y-4">
                     <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
                       <Badge variant="outline">{visibleProvider}</Badge>
                       <span>validated provider output</span>
                     </div>
                     {visibleCandidates.map(candidate => (
                       <Card
                         key={candidate.id}
                         className={cn(
                           "group transition-colors shadow-sm",
                           selectedCandidateId === candidate.id
                             ? "border-primary ring-1 ring-primary/30"
                             : "hover:border-primary/50",
                         )}
                       >
                         <CardContent className="p-4 flex items-center justify-between">
                           <div className="flex items-center gap-4">
                             <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-mono text-xs font-bold">
                               {Math.round(candidate.score * 100)}
                             </div>
                             <div>
                               <div className="font-semibold">{candidate.label}</div>
                               <div className="text-xs text-muted-foreground mt-0.5">{candidate.summary}</div>
                               <div className="text-[10px] font-mono text-muted-foreground mt-1">{candidate.provider}</div>
                             </div>
                           </div>
                           <Button
                             variant={selectedCandidateId === candidate.id ? "secondary" : "default"}
                             size="sm"
                             onClick={() => {
                               setSelectedCandidateId(candidate.id);
                               if (activeArrangement) {
                                 updateArrangement.mutate({
                                   arrangementId: activeArrangement.id,
                                   data: { selectedCandidateId: candidate.id },
                                 }, {
                                   onSuccess: () => {
                                     queryClient.invalidateQueries({
                                       queryKey: getListArrangementsQueryKey(projectId),
                                     });
                                   },
                                 });
                               }
                               toast({
                                 title: `${candidate.label} selected`,
                                 description: "Candidate selection saved to this arrangement.",
                               });
                             }}
                           >
                             {selectedCandidateId === candidate.id ? (
                               <><Check className="h-3.5 w-3.5 mr-1.5" /> Selected</>
                             ) : "Select"}
                           </Button>
                         </CardContent>
                       </Card>
                     ))}
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
        <aside className="w-[300px] border-l bg-card flex flex-col shrink-0 z-10 shadow-[-2px_0_10px_rgba(0,0,0,0.02)]">
          <div className="h-12 border-b flex items-center px-4 gap-2 font-semibold text-sm bg-muted/10">
            <Bot className="h-4 w-4 text-primary" />
            Studio Copilot
          </div>
          
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-4 text-sm">
              {copilotMessages.map((msg, i) => (
                <div key={i} className={cn("p-3 rounded-lg", msg.role === 'assistant' ? "bg-muted rounded-tl-none" : "bg-primary text-primary-foreground rounded-tr-none ml-6")}>
                  <p className={msg.operations?.length ? "mb-2" : ""}>{msg.text}</p>
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
            <form className="flex gap-2" onSubmit={handleCopilotSubmit}>
              <Input 
                placeholder="Ask copilot..." 
                className="text-sm shadow-sm" 
                value={copilotCommand}
                onChange={(e) => setCopilotCommand(e.target.value)}
                disabled={runCopilot.isPending}
              />
              <Button type="submit" size="icon" className="shrink-0" disabled={!copilotCommand.trim() || runCopilot.isPending}>
                <Bot className="h-4 w-4" />
              </Button>
            </form>
          </div>
        </aside>

      </div>

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
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-4">
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
              <Button onClick={handleExport} disabled={createExport.isPending}>
                {createExport.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                {createExport.isPending ? "Rendering files..." : "Render and download"}
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
