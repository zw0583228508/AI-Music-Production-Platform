import { Pause, Play, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AudioTransport } from "@/components/studio/use-audio-transport";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function AudioTransportControls({
  transport,
  compact = false,
}: {
  transport: AudioTransport;
  compact?: boolean;
}) {
  const isPlaying = transport.status === "playing";
  const isLoading = transport.status === "loading";
  const canPlay = transport.status !== "unavailable";

  return (
    <div className={cn("flex min-w-0 items-center gap-2", compact && "flex-1 gap-1 sm:flex-none")}>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className={cn("h-9 w-9 rounded-full", compact && "h-8 w-8")}
        aria-label={isPlaying ? "Pause arrangement" : "Play arrangement"}
        title={isPlaying ? "Pause" : "Play"}
        disabled={!canPlay || isLoading}
        onClick={transport.toggle}
      >
        {isLoading ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        ) : isPlaying ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="ml-0.5 h-4 w-4" />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn("h-9 w-9", compact && "h-8 w-8")}
        aria-label="Stop arrangement"
        title="Stop"
        disabled={!canPlay}
        onClick={transport.stop}
      >
        <Square className="h-3.5 w-3.5" />
      </Button>
      <input
        type="range"
        min={0}
        max={Math.max(0.01, transport.duration)}
        step={0.01}
        value={Math.min(transport.currentTime, Math.max(0.01, transport.duration))}
        aria-label="Seek arrangement"
        disabled={!canPlay || transport.duration <= 0}
        onChange={(event) => transport.seek(Number(event.currentTarget.value))}
        className="h-1.5 min-w-20 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40 md:w-28 md:flex-none"
      />
      <div
        data-testid="transport-time"
        aria-label="Current playback position"
        className={cn(
          "shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground",
          compact
            ? "min-w-[60px] text-center sm:min-w-[92px] sm:text-left"
            : "hidden min-w-[92px] sm:block",
        )}
      >
        {compact ? (
          <>
            <span className="sm:hidden">{formatTime(transport.currentTime)}</span>
            <span className="hidden sm:inline">
              {formatTime(transport.currentTime)} / {formatTime(transport.duration)}
            </span>
          </>
        ) : (
          `${formatTime(transport.currentTime)} / ${formatTime(transport.duration)}`
        )}
      </div>
      {transport.status === "error" && (
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Retry audio" title="Retry audio" onClick={transport.retry}>
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

export function AudioTransportStatus({
  transport,
  unavailableReason,
}: {
  transport: AudioTransport;
  unavailableReason?: string | null;
}) {
  if (transport.status === "error") {
    return (
      <span
        data-testid="transport-status"
        className="block min-w-0 max-w-full truncate text-[11px] text-destructive"
        title={transport.error ?? "Audio playback error"}
      >
        {transport.error ?? "Audio playback error"}
      </span>
    );
  }
  if (unavailableReason || transport.status === "unavailable") {
    return (
      <span
        data-testid="transport-status"
        className="block min-w-0 max-w-full truncate text-[11px] text-muted-foreground"
        title={unavailableReason ?? "Audio unavailable"}
      >
        {unavailableReason ?? "Audio unavailable"}
      </span>
    );
  }
  if (transport.status === "loading") {
    return (
      <span
        data-testid="transport-status"
        className="block min-w-0 max-w-full truncate text-[11px] text-muted-foreground"
      >
        Loading preview…
      </span>
    );
  }
  return (
    <span
      data-testid="transport-status"
      className="block min-w-0 max-w-full truncate text-[11px] text-muted-foreground"
    >
      Arrangement preview
    </span>
  );
}