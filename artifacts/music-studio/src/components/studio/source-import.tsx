import { useEffect, useRef, useState } from "react";
import {
  getListProjectSourcesQueryKey,
  ProjectSourceType,
  useListProjectSources,
  useRegisterProjectSource,
  useRequestSourceUploadUrl,
  useRetryProjectSourceAnalysis,
} from "@workspace/api-client-react";
import { useAuth } from "@workspace/replit-auth-web";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  FileAudio,
  Loader2,
  LogIn,
  RotateCcw,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  SUPPORTED_SOURCE_FILE_ACCEPT,
  SUPPORTED_SOURCE_FORMAT_LABEL,
  validateSourceFile,
} from "@/lib/source-file-formats";

const MAX_SIZE = 500 * 1024 * 1024;

function uploadFile(
  file: File,
  uploadUrl: string,
  onProgress: (value: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", uploadUrl);
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`Upload failed (${request.status})`));
    };
    request.onerror = () => reject(new Error("The upload connection failed"));
    request.send(file);
  });
}

export function SourceImport({
  projectId,
  sourceType,
  onReady,
}: {
  projectId: string;
  sourceType: ProjectSourceType;
  onReady: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const readySourceRef = useRef<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const auth = useAuth();
  const requestUpload = useRequestSourceUploadUrl();
  const registerSource = useRegisterProjectSource();
  const retryAnalysis = useRetryProjectSourceAnalysis();
  const { data: sources } = useListProjectSources(projectId, {
    query: {
      queryKey: getListProjectSourcesQueryKey(projectId),
      refetchInterval: open ? 1_500 : false,
    },
  });
  const currentSource = sources?.[0];
  const latestAttempt = currentSource?.attempts[0];

  useEffect(() => {
    if (
      currentSource?.status === "ready" &&
      readySourceRef.current !== currentSource.id
    ) {
      readySourceRef.current = currentSource.id;
      onReady();
      toast({
        title: "Song Model ready",
        description: `${currentSource.name} was analyzed successfully.`,
      });
    }
  }, [currentSource, onReady, toast]);

  const startImport = async () => {
    if (!file) return;
    const fileValidation = validateSourceFile(file);
    if (!fileValidation.valid) {
      toast({
        title: "Unsupported source file",
        description: fileValidation.message,
        variant: "destructive",
      });
      return;
    }
    if (file.size > MAX_SIZE) {
      toast({
        title: "File is too large",
        description: "The current upload limit is 500 MB.",
        variant: "destructive",
      });
      return;
    }
    setIsUploading(true);
    setUploadProgress(0);
    try {
      const { contentType } = fileValidation;
      const target = await requestUpload.mutateAsync({
        data: { projectId, name: file.name, size: file.size, contentType },
      });
      const uploadUrl = target.uploadURL.startsWith("/api/")
        ? `${import.meta.env.BASE_URL.replace(/\/$/, "")}${target.uploadURL}`
        : target.uploadURL;
      await uploadFile(file, uploadUrl, setUploadProgress);
      await registerSource.mutateAsync({
        projectId,
        data: {
          objectPath: target.objectPath,
          name: file.name,
          size: file.size,
          contentType,
          sourceType,
        },
      });
      await queryClient.invalidateQueries({
        queryKey: getListProjectSourcesQueryKey(projectId),
      });
      toast({
        title: "Upload complete",
        description: "Preprocessing and musical analysis have started.",
      });
    } catch (error) {
      toast({
        title: "Import failed",
        description: error instanceof Error ? error.message : "Could not import source.",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  const selectFile = (selectedFile: File | null) => {
    if (!selectedFile) {
      setFile(null);
      return;
    }
    const fileValidation = validateSourceFile(selectedFile);
    if (!fileValidation.valid) {
      setFile(null);
      toast({
        title: "Unsupported source file",
        description: fileValidation.message,
        variant: "destructive",
      });
      return;
    }
    setFile(selectedFile);
  };

  const retryCurrentSource = async () => {
    if (!currentSource) return;
    try {
      await retryAnalysis.mutateAsync({
        projectId,
        sourceId: currentSource.id,
      });
      await queryClient.invalidateQueries({
        queryKey: getListProjectSourcesQueryKey(projectId),
      });
      toast({
        title: "Analysis restarted",
        description: `Attempt ${(latestAttempt?.attemptNumber ?? 0) + 1} is now queued.`,
      });
    } catch (error) {
      toast({
        title: "Retry failed",
        description: error instanceof Error ? error.message : "Could not retry analysis.",
        variant: "destructive",
      });
    }
  };

  const stageLabel = latestAttempt?.stage === "preprocessing"
    ? "Downloading and normalizing audio"
    : latestAttempt?.stage === "probing"
      ? "Inspecting audio metadata"
      : latestAttempt?.stage === "analyzing"
        ? "Building Song Model"
        : latestAttempt?.stage === "persisting"
          ? "Saving Song Model"
          : null;
  const statusLabel = stageLabel
    ?? (currentSource?.status === "preprocessing"
      ? "Creating safe analysis proxy"
      : currentSource?.status === "analyzing"
        ? "Building Song Model"
      : currentSource?.status === "queued"
        ? "Queued"
        : currentSource?.status === "ready"
          ? "Analysis complete"
          : currentSource?.status === "failed"
            ? "Analysis failed"
            : null);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          Import Source
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a real source recording</DialogTitle>
          <DialogDescription>
            Upload {SUPPORTED_SOURCE_FORMAT_LABEL}. The original is preserved,
            and a non-destructive analysis proxy is created before the
            canonical Song Model.
          </DialogDescription>
        </DialogHeader>

        {!auth.isLoading && !auth.isAuthenticated ? (
          <div className="rounded-lg border bg-muted/30 p-5 text-center space-y-3">
            <LogIn className="h-7 w-7 text-primary mx-auto" />
            <div>
              <p className="font-semibold">Log in to upload source files</p>
              <p className="text-sm text-muted-foreground mt-1">
                Upload URLs are private and tied to your session.
              </p>
            </div>
            <Button onClick={auth.login}>Log in</Button>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed p-4 hover:border-primary/60 hover:bg-muted/20 transition-colors">
              <FileAudio className="h-7 w-7 text-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-medium truncate">
                  {file?.name || "Choose source file"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Up to 500 MB · audio, MIDI, or video
                </p>
              </div>
              <Input
                className="sr-only"
                type="file"
                accept={SUPPORTED_SOURCE_FILE_ACCEPT}
                onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
              />
            </label>

            {isUploading && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-mono">
                  <span>Uploading</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {currentSource && statusLabel && (
              <div className="rounded-lg border bg-card p-3">
                <div className="flex items-center gap-2">
                  {currentSource.status === "ready" ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  ) : currentSource.status === "failed" ? (
                    <AlertCircle className="h-4 w-4 text-destructive" />
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  )}
                  <span className="text-sm font-medium">{statusLabel}</span>
                  <span className="ml-auto text-xs font-mono text-muted-foreground">
                    {currentSource.progress}%
                  </span>
                </div>
                {currentSource.error && (
                  <p className="mt-2 text-xs text-destructive">{currentSource.error}</p>
                )}
                {currentSource.status === "failed" && (
                  <Button
                    className="mt-3 w-full"
                    variant="outline"
                    size="sm"
                    onClick={retryCurrentSource}
                    disabled={retryAnalysis.isPending}
                  >
                    {retryAnalysis.isPending ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="mr-2 h-3.5 w-3.5" />
                    )}
                    Retry analysis
                  </Button>
                )}
              </div>
            )}

            {currentSource?.attempts.length ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Attempt history
                </p>
                <div className="max-h-36 space-y-2 overflow-y-auto pr-1">
                  {currentSource.attempts.map((attempt) => (
                    <div
                      key={attempt.id}
                      className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
                    >
                      {attempt.status === "succeeded" ? (
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />
                      ) : attempt.status === "failed" || attempt.status === "interrupted" ? (
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                      ) : (
                        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">
                            Attempt {attempt.attemptNumber} · {attempt.stage}
                          </span>
                          <span className="font-mono text-muted-foreground">
                            {attempt.progress}%
                          </span>
                        </div>
                        <p className="mt-0.5 capitalize text-muted-foreground">
                          {attempt.status} · {new Date(attempt.createdAt).toLocaleString()}
                        </p>
                        {attempt.error && (
                          <p className="mt-1 text-destructive">{attempt.error}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <Button
              className="w-full"
              onClick={startImport}
              disabled={!file || isUploading || auth.isLoading}
            >
              {isUploading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              {isUploading ? "Uploading…" : "Upload and analyze"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}