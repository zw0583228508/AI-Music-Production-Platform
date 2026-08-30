import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { 
  useListLicensedInstrumentPacks, 
  useActivateLicensedInstrumentPack,
  useReactivateLicensedInstrumentPack,
  useStageLicensedInstrumentPack,
  getListLicensedInstrumentPacksQueryKey,
  type LicensedInstrumentPack,
  type StageLicensedInstrumentPackBody,
} from '@workspace/api-client-react';
import { 
  Package, Upload, CheckCircle, XCircle, Box, 
  Check, Loader2, Music2, ShieldCheck, HardDrive, 
  Cpu, FileWarning, Fingerprint, Key, CheckCircle2, CircleDashed,
  History, Play, RotateCcw
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export default function InstrumentPacks() {
  const { data, isLoading, error } = useListLicensedInstrumentPacks();
  
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <FileWarning className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Failed to load instrument packs.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const active = data?.active;
  const candidates = data?.candidates || [];
  const history = data?.history || { vst3: [], sfz: [] };
  const historyCount = history.vst3.length + history.sfz.length;

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
          <Package className="h-8 w-8 text-primary" />
          Instrument Packs
        </h1>
        <p className="text-muted-foreground text-lg">
          Manage and stage active VST3 and SFZ licensed instrument assets for the studio environment.
        </p>
      </div>

      <Tabs defaultValue="active" className="w-full">
        <TabsList className="grid w-full grid-cols-4 mb-8 max-w-3xl">
          <TabsTrigger value="active">Active Assets</TabsTrigger>
          <TabsTrigger value="candidates">Candidates ({candidates.length})</TabsTrigger>
          <TabsTrigger value="history">History ({historyCount})</TabsTrigger>
          <TabsTrigger value="stage">Stage New</TabsTrigger>
        </TabsList>
        
        <TabsContent value="active" className="space-y-6">
          <div className="grid md:grid-cols-2 gap-6">
            <ActivePackCard kind="vst3" pack={active?.vst3} />
            <ActivePackCard kind="sfz" pack={active?.sfz} />
          </div>
        </TabsContent>
        
        <TabsContent value="candidates" className="space-y-6">
          {candidates.length === 0 ? (
            <Card className="border-dashed bg-muted/30">
              <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Box className="h-12 w-12 mb-4 opacity-50" />
                <p>No candidates currently staged.</p>
                <p className="text-sm">Stage a new pack to run the smoke evidence verification.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-6">
              {candidates.map((candidate) => (
                <CandidateCard key={candidate.candidateId} pack={candidate} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="space-y-8">
          <Alert>
            <History className="h-4 w-4" />
            <AlertTitle>Verified rotation history</AlertTitle>
            <AlertDescription>
              Reactivation rechecks the original asset and host checksums against their smoke evidence before changing the active manifest.
            </AlertDescription>
          </Alert>
          {historyCount === 0 ? (
            <Card className="border-dashed bg-muted/30">
              <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <History className="h-12 w-12 mb-4 opacity-50" />
                <p>No previously active packs yet.</p>
                <p className="text-sm">A pack appears here after another verified version replaces it.</p>
              </CardContent>
            </Card>
          ) : (
            (['vst3', 'sfz'] as const).map((kind) => (
              <section key={kind} className="space-y-4">
                <div className="flex items-center gap-2">
                  {kind === 'vst3' ? <Cpu className="h-5 w-5 text-primary" /> : <Music2 className="h-5 w-5 text-primary" />}
                  <h2 className="text-xl font-semibold uppercase tracking-wide">{kind} history</h2>
                  <Badge variant="secondary">{history[kind].length}</Badge>
                </div>
                {history[kind].length === 0 ? (
                  <p className="text-sm text-muted-foreground border rounded-lg p-4">No previous {kind.toUpperCase()} versions.</p>
                ) : (
                  <div className="space-y-6">
                    {history[kind].map((pack) => (
                      <CandidateCard key={pack.historyId} pack={pack} isHistory />
                    ))}
                  </div>
                )}
              </section>
            ))
          )}
        </TabsContent>
        
        <TabsContent value="stage">
          <StageNewPackForm />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ActivePackCard({ kind, pack }: { kind: 'vst3' | 'sfz', pack?: LicensedInstrumentPack }) {
  const isAvailable = pack && pack.status === 'active';

  return (
    <Card className="overflow-hidden border-t-4 border-t-primary shadow-sm hover:shadow-md transition-shadow h-full flex flex-col">
      <CardHeader className="bg-muted/30 pb-4 border-b">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl flex items-center gap-2 uppercase tracking-wide">
            {kind === 'vst3' ? <Cpu className="h-5 w-5 text-primary" /> : <Music2 className="h-5 w-5 text-primary" />}
            {kind} Environment
          </CardTitle>
          <Badge variant={isAvailable ? 'default' : 'secondary'} className={isAvailable ? 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 border-emerald-500/20 dark:text-emerald-400' : ''}>
            {isAvailable ? 'Active' : 'Offline'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-6 flex-1 flex flex-col">
        {isAvailable ? (
          <div className="space-y-6 flex-1">
            <div className="space-y-1">
              <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-2">
                <Fingerprint className="h-4 w-4" /> Identity
              </div>
              <p className="text-lg font-semibold">{pack.identity}</p>
              <p className="text-sm font-mono text-muted-foreground break-all">{pack.assetId}</p>
            </div>
            
            <Separator />
            
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="space-y-1">
                <div className="font-medium text-muted-foreground flex items-center gap-2">
                  <Key className="h-4 w-4" /> License Owner
                </div>
                <p className="font-medium">{pack.licenseOwner}</p>
              </div>
              <div className="space-y-1">
                <div className="font-medium text-muted-foreground flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4" /> Reference
                </div>
                <p className="font-mono text-xs break-all">{pack.licenseReference}</p>
              </div>
            </div>

            <div className="space-y-2 bg-muted/40 p-3 rounded-md text-xs font-mono mt-auto">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Asset SHA-256:</span>
                <span className="text-foreground truncate ml-4" title={pack.sha256}>{pack.sha256?.substring(0, 16)}...</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Host SHA-256:</span>
                <span className="text-foreground truncate ml-4" title={pack.rendererSha256}>{pack.rendererSha256?.substring(0, 16)}...</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Renderer Identity:</span>
                <span className="text-foreground text-right">{pack.rendererIdentity}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Activated:</span>
                <span className="text-foreground text-right">{pack.activatedAt ? new Date(pack.activatedAt).toLocaleString() : 'N/A'}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-3 flex-1">
            <CircleDashed className="h-10 w-10 opacity-20" />
            <p className="font-medium">No Active {kind.toUpperCase()} Pack</p>
            <p className="text-sm text-center max-w-xs">Stage and verify a candidate to activate this environment.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CandidateCard({ pack, isHistory = false }: { pack: LicensedInstrumentPack, isHistory?: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const activateMutation = useActivateLicensedInstrumentPack({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Pack Activated",
          description: `Successfully activated ${pack.identity} (${pack.kind}).`,
        });
        queryClient.invalidateQueries({ queryKey: getListLicensedInstrumentPacksQueryKey() });
      },
      onError: () => {
        toast({
          title: "Activation Failed",
          description: "Could not activate this candidate. See console for details.",
          variant: "destructive"
        });
      }
    }
  });
  const reactivateMutation = useReactivateLicensedInstrumentPack({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Pack Reactivated",
          description: `Restored ${pack.identity} (${pack.kind}) after checksum revalidation.`,
        });
        queryClient.invalidateQueries({ queryKey: getListLicensedInstrumentPacksQueryKey() });
      },
      onError: () => {
        toast({
          title: "Reactivation Blocked",
          description: "The historical bytes or smoke evidence no longer match. The active pack was not changed.",
          variant: "destructive"
        });
      }
    }
  });

  const isVerified = pack.status === 'verified';
  const isFailed = pack.status === 'unavailable'; 
  const isActive = pack.status === 'active';
  const isPending = activateMutation.isPending || reactivateMutation.isPending;

  return (
    <Card className={`overflow-hidden transition-all duration-300 ${isVerified ? 'border-primary/30 shadow-sm' : ''}`}>
      <div className="flex flex-col md:flex-row">
        {/* Left Side: Meta info */}
        <div className="p-6 border-b md:border-b-0 md:border-r bg-muted/10 md:w-[320px] shrink-0 flex flex-col">
          <div className="flex items-center gap-2 mb-4">
            <Badge variant="outline" className="uppercase font-mono text-xs">{pack.kind}</Badge>
            {isVerified && <Badge className="bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 border-emerald-500/20 dark:text-emerald-400 gap-1"><CheckCircle2 className="h-3 w-3" /> Verified</Badge>}
            {isFailed && <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" /> Unavailable</Badge>}
            {isActive && <Badge variant="default" className="gap-1 bg-blue-500 hover:bg-blue-600 text-white"><Check className="h-3 w-3" /> Active</Badge>}
          </div>
          
          <h3 className="text-lg font-bold mb-1">{pack.identity}</h3>
          <p className="text-sm font-mono text-muted-foreground mb-6 break-all">{pack.assetId}</p>
          
          <div className="space-y-3 text-sm mt-auto">
            <div>
              <span className="text-muted-foreground block text-xs">Owner</span>
              <span className="font-medium">{pack.licenseOwner}</span>
            </div>
            <div>
              <span className="text-muted-foreground block text-xs">Reference</span>
              <span className="font-mono text-xs break-all">{pack.licenseReference}</span>
            </div>
            <div>
              <span className="text-muted-foreground block text-xs">Renderer</span>
              <span className="font-medium">{pack.rendererIdentity}</span>
            </div>
            <div>
              <span className="text-muted-foreground block text-xs">Asset SHA-256</span>
              <span className="font-mono text-xs break-all">{pack.sha256}</span>
            </div>
            <div>
              <span className="text-muted-foreground block text-xs">Host SHA-256</span>
              <span className="font-mono text-xs break-all">{pack.rendererSha256}</span>
            </div>
            {isHistory && (
              <>
                <div>
                  <span className="text-muted-foreground block text-xs">Originally activated</span>
                  <span className="text-xs">{pack.activatedAt ? new Date(pack.activatedAt).toLocaleString() : 'Recorded before activation timestamps'}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block text-xs">Rotated out</span>
                  <span className="text-xs">{pack.deactivatedAt ? new Date(pack.deactivatedAt).toLocaleString() : 'N/A'}</span>
                </div>
              </>
            )}
          </div>
          
          {isVerified && !isActive && (
            <Button 
              className="mt-6 w-full font-bold shadow-md" 
              onClick={() => {
                if (isHistory) {
                  reactivateMutation.mutate({ historyId: pack.historyId! });
                } else {
                  activateMutation.mutate({ candidateId: pack.candidateId! });
                }
              }}
              disabled={isPending}
            >
              {isPending
                ? <Loader2 className="h-4 w-4 animate-spin mr-2" />
                : isHistory
                  ? <RotateCcw className="h-4 w-4 mr-2" />
                  : <Play className="h-4 w-4 mr-2" />}
              {isHistory ? 'Reactivate Verified Pack' : 'Activate This Pack'}
            </Button>
          )}
          {isHistory && isFailed && (
            <Alert variant="destructive" className="mt-6">
              <FileWarning className="h-4 w-4" />
              <AlertTitle>Reactivation unavailable</AlertTitle>
              <AlertDescription>
                {pack.unavailableReason || 'Historical bytes no longer match the verified checksums.'}
              </AlertDescription>
            </Alert>
          )}
        </div>

        {/* Right Side: Smoke Evidence */}
        <div className="p-6 flex-1 bg-card">
          <h4 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Canonical Smoke Evidence
          </h4>
          
          {pack.smokeEvidence ? (
            <div className="grid sm:grid-cols-2 gap-x-8 gap-y-6">
              <div className="space-y-4">
                <EvidenceItem label="TrackModel Rendered" value={pack.smokeEvidence.trackModelRendered} />
                <EvidenceItem label="Audible Output" value={pack.smokeEvidence.audible} />
                <EvidenceItem label="Canonical Sensitivity" value={pack.smokeEvidence.canonicalSensitivity} />
                <EvidenceItem label="Native Host Attested" value={pack.smokeEvidence.nativeHostAttested} />
              </div>
              <div className="space-y-3">
                <div className="bg-muted/30 rounded-lg p-3 space-y-2 border">
                  <EvidenceMetric label="Peak amplitude" value={pack.smokeEvidence.peak.toFixed(4)} />
                  <EvidenceMetric label="Duration" value={`${pack.smokeEvidence.durationSeconds.toFixed(2)}s`} />
                  <EvidenceMetric label="Sample Rate" value={`${pack.smokeEvidence.sampleRate} Hz`} />
                  <EvidenceMetric label="Format" value={pack.smokeEvidence.format} />
                </div>
                
                <div className="space-y-2 pt-2">
                  <EvidenceHash label="Output SHA" hash={pack.smokeEvidence.outputSha256} />
                  <EvidenceHash label="Pitch Var SHA" hash={pack.smokeEvidence.pitchVariantSha256} />
                  <EvidenceHash label="Expr Var SHA" hash={pack.smokeEvidence.expressionVariantSha256} />
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center py-8 text-muted-foreground gap-3">
              {isFailed ? (
                <>
                  <FileWarning className="h-8 w-8 text-destructive opacity-80" />
                  <p className="font-medium text-destructive">{isHistory ? 'Historical bytes unavailable.' : 'Smoke evidence failed.'}</p>
                  <p className="text-sm">{isHistory ? 'This version cannot replace the active pack.' : 'The candidate did not pass validation checks.'}</p>
                </>
              ) : (
                <>
                  <Loader2 className="h-8 w-8 animate-spin opacity-50" />
                  <p>Processing smoke evidence...</p>
                  <p className="text-sm">Validation is running in the background.</p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function EvidenceItem({ label, value }: { label: string, value: boolean }) {
  return (
    <div className="flex items-center justify-between group">
      <span className="text-sm font-medium group-hover:text-foreground transition-colors">{label}</span>
      {value ? (
        <CheckCircle className="h-5 w-5 text-emerald-500" />
      ) : (
        <XCircle className="h-5 w-5 text-destructive" />
      )}
    </div>
  );
}

function EvidenceMetric({ label, value }: { label: string, value: string }) {
  return (
    <div className="flex justify-between items-center text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium">{value}</span>
    </div>
  );
}

function EvidenceHash({ label, hash }: { label: string, hash: string }) {
  return (
    <div className="flex flex-col text-xs space-y-1">
      <span className="text-muted-foreground font-medium uppercase tracking-wider text-[10px]">{label}</span>
      <span className="font-mono bg-muted/50 p-1.5 rounded truncate border text-muted-foreground hover:text-foreground transition-colors" title={hash}>
        {hash}
      </span>
    </div>
  );
}

function StageNewPackForm() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [kind, setKind] = useState<'vst3' | 'sfz'>('vst3');
  const [selectedFiles, setSelectedFiles] = useState({ count: 0, bytes: 0 });
  
  const stageMutation = useStageLicensedInstrumentPack({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Pack Verified",
          description: "Checksums and canonical TrackModel evidence are ready for review.",
        });
        queryClient.invalidateQueries({ queryKey: getListLicensedInstrumentPacksQueryKey() });
        (document.getElementById('stage-form') as HTMLFormElement | null)?.reset();
        setSelectedFiles({ count: 0, bytes: 0 });
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : "The upload could not be verified.";
        toast({
          title: "Staging Failed",
          description: message.includes("active pack was not changed")
            ? message
            : `${message} The active instrument pack was not changed.`,
          variant: "destructive"
        });
      }
    }
  });

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    
    const assetId = (form.elements.namedItem('assetId') as HTMLInputElement).value;
    const identity = (form.elements.namedItem('identity') as HTMLInputElement).value;
    const licenseOwner = (form.elements.namedItem('licenseOwner') as HTMLInputElement).value;
    const licenseReference = (form.elements.namedItem('licenseReference') as HTMLInputElement).value;
    const rendererIdentity = (form.elements.namedItem('rendererIdentity') as HTMLInputElement).value;
    
    const rendererFileInput = form.elements.namedItem('rendererFile') as HTMLInputElement;
    const assetFilesInput = form.elements.namedItem('assetFiles') as HTMLInputElement;
    const rendererFile = rendererFileInput.files?.[0];
    const assetFiles = Array.from(assetFilesInput.files ?? []);
    if (!rendererFile || assetFiles.length === 0) {
      toast({
        title: "Files required",
        description: "Choose the native host and at least one instrument file before staging.",
        variant: "destructive",
      });
      return;
    }

    const data: StageLicensedInstrumentPackBody = {
      kind,
      assetId,
      identity,
      licenseOwner,
      licenseReference,
      rendererIdentity,
      rendererFile,
      assetFiles,
      assetRelativePaths: assetFiles.map((file) => file.webkitRelativePath || file.name),
    };
    stageMutation.mutate({ data });
  };

  const updateSelectedFiles = (input: HTMLInputElement) => {
    const files = Array.from(input.files ?? []);
    setSelectedFiles({
      count: files.length,
      bytes: files.reduce((total, file) => total + file.size, 0),
    });
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <Card className="max-w-3xl mx-auto shadow-md">
      <CardHeader className="bg-muted/20 border-b">
        <CardTitle className="text-xl flex items-center gap-2">
          <Upload className="h-5 w-5 text-primary" />
          Stage Candidate Pack
        </CardTitle>
        <CardDescription>
          Upload a new plugin or library candidate. The system will automatically generate canonical smoke evidence before allowing activation.
        </CardDescription>
      </CardHeader>
      
      <form id="stage-form" onSubmit={onSubmit}>
        <CardContent className="space-y-8 pt-6">
          <div className="grid md:grid-cols-2 gap-8">
            {/* Column 1: Details */}
            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="kind" className="font-semibold">Target Environment</Label>
                <Select
                  value={kind}
                  onValueChange={(value) => {
                    setKind(value as 'vst3' | 'sfz');
                    setSelectedFiles({ count: 0, bytes: 0 });
                  }}
                  name="kind"
                >
                  <SelectTrigger id="kind" className="bg-background">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="vst3">VST3 Plugin</SelectItem>
                    <SelectItem value="sfz">SFZ Library</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="identity" className="font-semibold">Exact Identity</Label>
                <Input id="identity" name="identity" placeholder="e.g. Studio Grand Piano v2" required className="bg-background" />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="assetId" className="font-semibold">Asset ID</Label>
                <Input id="assetId" name="assetId" placeholder="e.g. org.creator.studiogrand.v2" required className="font-mono text-sm bg-background" />
              </div>
            </div>

            {/* Column 2: License & Renderer */}
            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="licenseOwner" className="font-semibold">License Owner</Label>
                <Input id="licenseOwner" name="licenseOwner" placeholder="e.g. Studio AI Inc." required className="bg-background" />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="licenseReference" className="font-semibold">License Reference / Token</Label>
                <Input id="licenseReference" name="licenseReference" placeholder="e.g. LICENSE-1234-ABCD" required className="bg-background font-mono text-sm" />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="rendererIdentity" className="font-semibold">Native Host / Renderer Identity</Label>
                <Input id="rendererIdentity" name="rendererIdentity" placeholder="e.g. Sforzando / Kontakt 7" required className="bg-background" />
              </div>
            </div>
          </div>
          
          <Separator />
          
          <div className="space-y-6">
            <h4 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <HardDrive className="h-4 w-4" /> Files & Assets
            </h4>
            
            <div className="grid md:grid-cols-2 gap-6 bg-muted/20 p-5 rounded-lg border">
              <div className="space-y-3">
                <Label htmlFor="rendererFile" className="font-semibold">Approved Native Host Executable</Label>
                <Input 
                  id="rendererFile" 
                  name="rendererFile" 
                  type="file" 
                  required 
                  className="bg-background cursor-pointer file:text-primary file:font-medium" 
                />
                <p className="text-xs text-muted-foreground">The exact approved MIDI render host. Its checksum is pinned with the pack.</p>
              </div>
              
              <div className="space-y-3">
                <Label htmlFor="assetFiles" className="font-semibold">
                  {kind === 'sfz' ? 'SFZ Library Directory' : 'VST3 Plugin'}
                </Label>
                {kind === 'sfz' ? (
                  <Input
                    key="sfz-directory"
                    id="assetFiles"
                    name="assetFiles"
                    type="file"
                    multiple
                    required
                    {...{ webkitdirectory: "", directory: "" } as Record<string, string>}
                    onChange={(event) => updateSelectedFiles(event.currentTarget)}
                    className="bg-background cursor-pointer file:text-primary file:font-medium"
                  />
                ) : (
                  <Input
                    key="vst3-file"
                    id="assetFiles"
                    name="assetFiles"
                    type="file"
                    required
                    onChange={(event) => updateSelectedFiles(event.currentTarget)}
                    className="bg-background cursor-pointer file:text-primary file:font-medium"
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  {kind === 'sfz'
                    ? 'Select the complete library root so samples and SFZ definitions remain together.'
                    : 'Select the licensed VST3 plugin file. The worker verifies it can be loaded before activation.'}
                </p>
                {selectedFiles.count > 0 && (
                  <p className="text-xs font-medium text-primary" data-testid="selected-pack-size">
                    {selectedFiles.count} file{selectedFiles.count === 1 ? '' : 's'} selected · {formatBytes(selectedFiles.bytes)}.
                    {' '}The pack is streamed to private storage; verification may take several minutes.
                  </p>
                )}
              </div>
            </div>
          </div>
        </CardContent>
        <CardFooter className="bg-muted/20 border-t py-4 px-6 flex justify-end">
          <Button type="submit" disabled={stageMutation.isPending} className="font-bold min-w-[140px]">
            {stageMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                Stage & Verify
              </>
            )}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
