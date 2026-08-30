import * as React from "react";
import { 
  ShieldCheck, 
  AlertTriangle, 
  Cpu, 
  Fingerprint, 
  FileAudio,
  ChevronDown,
  ChevronRight,
  Server,
  KeyRound
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export interface RenderEvidence {
  trackName: string;
  role: string;
  rendererStatus: 'licensed-native' | 'deterministic-fallback';
  rendererProvider?: string;
  rendererProduct?: string;
  nativeHost?: string;
  licenseOwner?: string;
  licenseReference?: string;
  assetSha256?: string;
  rendererSha256?: string;
  smokeOutputSha256?: string;
  trackModelSha256?: string;
  rendererOutputSha256?: string;
  stemOutputSha256?: string;
  fallbackReason?: string;
}

export interface ExportRenderEvidenceProps {
  evidence?: RenderEvidence[];
}

export function ExportRenderEvidence({ evidence = [] }: ExportRenderEvidenceProps) {
  if (!evidence || evidence.length === 0) {
    return (
      <div className="text-sm text-muted-foreground italic p-6 text-center border rounded-lg bg-muted/20 border-dashed">
        No cryptographic render evidence available for this export package.
      </div>
    );
  }

  const nativeCount = evidence.filter(e => e.rendererStatus === 'licensed-native').length;
  const fallbackCount = evidence.length - nativeCount;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
          <h3 className="text-sm font-semibold tracking-tight">Cryptographic Render Evidence</h3>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {nativeCount > 0 && (
            <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20">
              {nativeCount} Native
            </Badge>
          )}
          {fallbackCount > 0 && (
            <Badge variant="outline" className="bg-amber-500/10 text-amber-700 border-amber-500/30">
              {fallbackCount} Fallback
            </Badge>
          )}
        </div>
      </div>
      
      <div className="space-y-2">
        {evidence.map((item, index) => (
          <EvidenceItem key={`${item.trackName}-${item.role}-${index}`} item={item} />
        ))}
      </div>
    </div>
  );
}

function EvidenceItem({ item }: { item: RenderEvidence }) {
  const [isOpen, setIsOpen] = React.useState(false);
  const isNative = item.rendererStatus === 'licensed-native';

  return (
    <Card className={cn(
      "overflow-hidden transition-all duration-200 shadow-none border", 
      isNative ? "border-primary/10 hover:border-primary/30" : "border-amber-500/20 hover:border-amber-500/40"
    )}>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="w-full flex items-center justify-between p-3 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <div className="flex items-center gap-3">
            <div className={cn(
              "h-8 w-8 rounded-md flex items-center justify-center shrink-0 border",
              isNative ? "bg-primary/10 border-primary/20 text-primary" : "bg-amber-500/10 border-amber-500/20 text-amber-600"
            )}>
              {isNative ? (
                <Cpu className="h-4 w-4" aria-label="Licensed Native Render" />
              ) : (
                <Server className="h-4 w-4" aria-label="Deterministic Fallback Render" />
              )}
            </div>
            <div className="flex flex-col items-start text-left">
              <span className="text-sm font-medium leading-none mb-1">{item.trackName}</span>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">{item.role}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge 
              variant={isNative ? "default" : "outline"} 
              className={cn(
                "h-6 rounded-sm px-2 text-[10px] uppercase font-bold tracking-wide",
                !isNative && "border-amber-500/30 text-amber-700 bg-amber-500/10"
              )}
            >
              {isNative ? "Licensed Native" : "Deterministic Fallback"}
            </Badge>
            <div className="text-muted-foreground shrink-0">
              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </div>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <CardContent className="pt-0 pb-3 px-3">
            <div className={cn(
              "p-3 rounded-lg border text-xs space-y-4 mt-1",
              isNative ? "bg-primary/5 border-primary/10" : "bg-amber-500/5 border-amber-500/10"
            )}>
              
              {isNative ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground flex items-center gap-1.5">
                        <FileAudio className="h-3 w-3" /> Provider / Product
                      </span>
                      <div className="font-mono text-xs bg-background/50 border border-border/50 rounded px-2 py-1.5 truncate">
                        {item.rendererProvider} <span className="text-muted-foreground">/</span> {item.rendererProduct}
                      </div>
                    </div>
                    
                    <div className="space-y-1.5">
                      <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground flex items-center gap-1.5">
                        <Cpu className="h-3 w-3" /> Native Host
                      </span>
                      <div className="font-mono text-xs bg-background/50 border border-border/50 rounded px-2 py-1.5 truncate">
                        {item.nativeHost || "N/A"}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <KeyRound className="h-3 w-3" /> License Verification
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="bg-background/80 border border-border/50 rounded px-2.5 py-2">
                        <span className="text-[9px] uppercase tracking-wider text-muted-foreground block mb-1">Owner</span>
                        <span className="font-mono text-xs truncate block">{item.licenseOwner || "Unknown"}</span>
                      </div>
                      <div className="bg-background/80 border border-border/50 rounded px-2.5 py-2">
                        <span className="text-[9px] uppercase tracking-wider text-muted-foreground block mb-1">Reference</span>
                        <span className="font-mono text-xs truncate block">{item.licenseReference || "N/A"}</span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <Fingerprint className="h-3 w-3" /> Cryptographic Checksums
                    </span>
                    <div className="space-y-1 bg-background/80 border border-border/50 rounded p-1.5">
                      <ChecksumRow label="Asset Signature" hash={item.assetSha256} />
                      <ChecksumRow label="Native Host SHA256" hash={item.rendererSha256} />
                      <ChecksumRow label="Smoke Evidence SHA256" hash={item.smokeOutputSha256} />
                      <ChecksumRow label="Track Model SHA256" hash={item.trackModelSha256} />
                      <ChecksumRow label="Renderer Output SHA256" hash={item.rendererOutputSha256} />
                      <ChecksumRow label="Exported Stem SHA256" hash={item.stemOutputSha256} />
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex gap-3 text-amber-800 dark:text-amber-200">
                  <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                  <div className="space-y-1">
                    <p className="font-semibold text-sm leading-none mt-0.5">Deterministic Rendering Applied</p>
                    <p className="text-amber-700/80 dark:text-amber-300/80 leading-relaxed">
                      {item.fallbackReason ? (
                        <>Licensed-native audio was not eligible for this export ({item.fallbackReason}). A deterministic synthesizer produced the included stem instead. No native audio is retained or attributed to this stem.</>
                      ) : (
                        <>A baseline deterministic synthesizer was used to render this stem. No licensed native provider was executed.</>
                      )}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function ChecksumRow({ label, hash }: { label: string, hash?: string }) {
  if (!hash) return null;
  return (
    <div className="flex items-center justify-between rounded px-2 py-1 hover:bg-muted/50 transition-colors group">
      <span className="text-[10px] text-muted-foreground shrink-0 w-28 uppercase font-medium tracking-wide">{label}</span>
      <span className="font-mono text-[10px] truncate text-foreground/70 group-hover:text-foreground transition-colors" title={hash}>
        {hash}
      </span>
    </div>
  );
}
