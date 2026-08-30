import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  getGetDashboardQueryKey,
  getGetProjectDeletionQueryKey,
  getListProjectsQueryKey,
  Project,
  ProjectSourceType,
  ProjectStatus,
  useCreateProject,
  useDeleteProject,
  useGetProjectDeletion,
  useListProjects,
  useRetryProjectDeletion,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  Library, 
  Plus, 
  Search, 
  Music2, 
  Mic2, 
  Piano, 
  Activity,
  Clock,
  Music,
  Loader2,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty";
import { 
  Dialog, 
  DialogContent, 
  DialogDescription, 
  DialogFooter, 
  DialogHeader, 
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

type PendingCleanup = {
  id: string;
  projectName: string;
};

const pendingCleanupStorageKey = "music-studio:pending-project-cleanups";

function readPendingCleanups(): PendingCleanup[] {
  try {
    const value = window.localStorage.getItem(pendingCleanupStorageKey);
    if (!value) return [];
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PendingCleanup =>
      Boolean(
        item &&
        typeof item === "object" &&
        typeof (item as PendingCleanup).id === "string" &&
        typeof (item as PendingCleanup).projectName === "string",
      )
    );
  } catch {
    return [];
  }
}

function PendingCleanupNotice({
  cleanup,
  onResolved,
}: {
  cleanup: PendingCleanup;
  onResolved: (id: string) => void;
}) {
  const { toast } = useToast();
  const retryProjectDeletion = useRetryProjectDeletion();
  const { data: cleanupStatus } = useGetProjectDeletion(cleanup.id, {
    query: {
      queryKey: getGetProjectDeletionQueryKey(cleanup.id),
      retry: false,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "queued" || status === "running" ? 1_000 : false;
      },
    },
  });

  useEffect(() => {
    if (cleanupStatus?.status === "completed") {
      onResolved(cleanup.id);
      toast({
        title: "Stored files removed",
        description: `Cleanup finished for ${cleanup.projectName}.`,
      });
    }
  }, [cleanup.id, cleanup.projectName, cleanupStatus?.status, onResolved, toast]);

  const handleRetry = async () => {
    try {
      const result = await retryProjectDeletion.mutateAsync({
        deletionId: cleanup.id,
      });
      if (result.status === "completed") {
        onResolved(cleanup.id);
        toast({
          title: "Stored files removed",
          description: `Cleanup finished for ${cleanup.projectName}.`,
        });
      } else {
        toast({
          title: "Cleanup still incomplete",
          description: "The remaining files are still tracked. You can retry again.",
          variant: "destructive",
        });
      }
    } catch (retryError) {
      toast({
        title: "Cleanup retry failed",
        description: retryError instanceof Error
          ? retryError.message
          : "Try again in a moment.",
        variant: "destructive",
      });
    }
  };

  return (
    <Alert variant="destructive">
      <TriangleAlert className="h-4 w-4" />
      <AlertTitle>Stored file cleanup needs attention</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>
          {cleanup.projectName} is deleted, but{" "}
          {cleanupStatus
            ? `${cleanupStatus.pendingObjectCount} private storage item${cleanupStatus.pendingObjectCount === 1 ? "" : "s"} remain.`
            : "its private storage cleanup is being checked."}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRetry}
          disabled={
            retryProjectDeletion.isPending ||
            cleanupStatus?.status === "queued" ||
            cleanupStatus?.status === "running" ||
            !cleanupStatus
          }
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${retryProjectDeletion.isPending ? "animate-spin" : ""}`} />
          Retry cleanup
        </Button>
      </AlertDescription>
    </Alert>
  );
}

const StatusBadge = ({ status }: { status: ProjectStatus }) => {
  const map: Record<ProjectStatus, { label: string, color: string }> = {
    draft: { label: "Draft", color: "bg-gray-500/10 text-gray-700 dark:text-gray-300" },
    analyzing: { label: "Analyzing", color: "bg-blue-500/10 text-blue-700 dark:text-blue-300" },
    ready: { label: "Ready", color: "bg-green-500/10 text-green-700 dark:text-green-300" },
    rendering: { label: "Rendering", color: "bg-primary/10 text-primary" }
  };
  const config = map[status];
  
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${config.color}`}>
      {status === 'analyzing' || status === 'rendering' ? (
        <Activity className="mr-1 h-3 w-3 animate-pulse" />
      ) : null}
      {config.label}
    </span>
  );
};

const SourceTypeIcon = ({ type }: { type: ProjectSourceType }) => {
  switch (type) {
    case 'FULL_SONG': return <Disc3 className="h-4 w-4" />;
    case 'VOCAL_ONLY': return <Mic2 className="h-4 w-4" />;
    case 'SOLO_INSTRUMENT': return <Piano className="h-4 w-4" />;
    case 'INSTRUMENTAL': return <Music2 className="h-4 w-4" />;
    default: return <Music className="h-4 w-4" />;
  }
};

import { Disc3 } from "lucide-react";

export default function Projects() {
  const [search, setSearch] = useState("");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: projects, isLoading, error } = useListProjects();
  const createProject = useCreateProject();
  const deleteProject = useDeleteProject();

  const [open, setOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newSourceType, setNewSourceType] = useState<ProjectSourceType>('FULL_SONG');
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [pendingCleanups, setPendingCleanups] = useState<PendingCleanup[]>(
    readPendingCleanups,
  );
  
  const filteredProjects = projects?.filter(p => 
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  const removePendingCleanup = useCallback((id: string) => {
    setPendingCleanups((current) => {
      const next = current.filter((cleanup) => cleanup.id !== id);
      window.localStorage.setItem(pendingCleanupStorageKey, JSON.stringify(next));
      return next;
    });
  }, []);

  const rememberPendingCleanup = (cleanup: PendingCleanup) => {
    setPendingCleanups((current) => {
      const next = [
        ...current.filter((item) => item.id !== cleanup.id),
        cleanup,
      ];
      window.localStorage.setItem(pendingCleanupStorageKey, JSON.stringify(next));
      return next;
    });
  };

  const handleCreate = () => {
    if (!newProjectName.trim()) return;

    createProject.mutate({
      data: {
        name: newProjectName,
        sourceType: newSourceType
      }
    }, {
      onSuccess: (newProject) => {
        toast({ title: "Project Created", description: `Opened ${newProject.name}` });
        setOpen(false);
        setNewProjectName("");
        queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        setLocation(`/projects/${newProject.id}`);
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to create project", variant: "destructive" });
      }
    });
  };

  const handleDelete = async () => {
    if (!projectToDelete) return;
    const deletedProject = projectToDelete;
    try {
      const deletion = await deleteProject.mutateAsync({
        projectId: deletedProject.id,
      });
      queryClient.setQueryData<Project[]>(
        getListProjectsQueryKey(),
        (current) => current?.filter((project) => project.id !== deletedProject.id),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
      ]);
      setProjectToDelete(null);
      if (deletion.status === "completed") {
        removePendingCleanup(deletion.id);
      } else {
        rememberPendingCleanup({
          id: deletion.id,
          projectName: deletedProject.name,
        });
      }
      toast({
        title: "Project deleted",
        description: deletion.status === "completed"
          ? `${deletedProject.name} and its stored files were removed.`
          : `${deletedProject.name} was removed. Use the cleanup notice to retry its remaining stored files.`,
      });
    } catch (deleteError) {
      toast({
        title: "Project could not be deleted",
        description: deleteError instanceof Error
          ? deleteError.message
          : "Try again in a moment.",
        variant: "destructive",
      });
    }
  };

  if (error) {
    return (
      <div className="p-6 md:p-10 text-center">
        <p className="text-destructive font-semibold">Failed to load projects.</p>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-10 max-w-6xl mx-auto space-y-8 pb-20 h-full flex flex-col">
      <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Library className="h-7 w-7 text-primary" />
            Projects
          </h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Manage your arrangements and multi-track sessions.
          </p>
        </div>
        
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="shadow-sm shadow-primary/20">
              <Plus className="mr-2 h-4 w-4" />
              New Project
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Create New Project</DialogTitle>
              <DialogDescription>
                Set up a new workspace to analyze and arrange a song.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-6 py-4">
              <div className="space-y-2">
                <Label htmlFor="name">Project Name</Label>
                <Input 
                  id="name" 
                  placeholder="e.g. Neon City Edit" 
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="type">Source Type</Label>
                <Select value={newSourceType} onValueChange={(v) => setNewSourceType(v as ProjectSourceType)}>
                  <SelectTrigger id="type">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FULL_SONG">Full Song</SelectItem>
                    <SelectItem value="VOCAL_ONLY">Vocal Acapella</SelectItem>
                    <SelectItem value="SOLO_INSTRUMENT">Solo Instrument</SelectItem>
                    <SelectItem value="INSTRUMENTAL">Instrumental</SelectItem>
                    <SelectItem value="MIDI">MIDI Data</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={!newProjectName.trim() || createProject.isPending}>
                {createProject.isPending ? "Creating..." : "Create Project"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </header>

      <div className="flex items-center gap-4 shrink-0">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search projects..."
            className="pl-9 bg-card shadow-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {pendingCleanups.map((cleanup) => (
        <PendingCleanupNotice
          key={cleanup.id}
          cleanup={cleanup}
          onResolved={removePendingCleanup}
        />
      ))}

      <div className="flex-1 overflow-auto -mx-6 px-6 -my-4 py-4">
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map(i => (
              <Card key={i} className="h-48 shadow-sm">
                <CardContent className="p-5 flex flex-col h-full gap-4">
                  <div className="flex justify-between">
                    <Skeleton className="h-10 w-10 rounded-md" />
                    <Skeleton className="h-6 w-16 rounded-full" />
                  </div>
                  <Skeleton className="h-6 w-3/4" />
                  <div className="mt-auto flex gap-4">
                    <Skeleton className="h-4 w-12" />
                    <Skeleton className="h-4 w-16" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : !filteredProjects?.length ? (
          <EmptyState 
            icon={Library} 
            title={search ? "No projects found" : "No projects yet"} 
            description={search ? "Try a different search term." : "Create your first project to get started."}
            action={!search ? (
              <Button onClick={() => setOpen(true)} className="mt-4">
                <Plus className="mr-2 h-4 w-4" />
                Create Project
              </Button>
            ) : undefined}
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {filteredProjects.map((project) => (
              <div key={project.id} className="relative">
                <Link href={`/projects/${project.id}`}>
                  <Card className="h-full overflow-hidden hover:border-primary/50 transition-colors shadow-sm group cursor-pointer active-elevate flex flex-col">
                    <div className="h-1.5 w-full" style={{ backgroundColor: project.coverColor || 'hsl(var(--primary))' }} />
                    <CardContent className="p-5 flex flex-col h-full">
                      <div className="flex justify-between items-start mb-4 pr-10">
                        <div className="p-2.5 bg-muted rounded-lg text-muted-foreground group-hover:text-primary group-hover:bg-primary/10 transition-colors">
                          <SourceTypeIcon type={project.sourceType} />
                        </div>
                        <StatusBadge status={project.status} />
                      </div>
                    
                      <h3 className="text-lg font-bold text-foreground mb-1 group-hover:text-primary transition-colors line-clamp-1">
                        {project.name}
                      </h3>
                    
                      <div className="flex items-center gap-3 text-sm font-mono text-muted-foreground mb-4">
                        <div className="flex items-center gap-1.5">
                          <Activity className="h-3.5 w-3.5" />
                          {project.bpm} BPM
                        </div>
                        <div className="w-1 h-1 rounded-full bg-border" />
                        <div className="flex items-center gap-1.5">
                          <Music className="h-3.5 w-3.5" />
                          {project.key}
                        </div>
                      </div>

                      <div className="mt-auto pt-4 border-t flex items-center justify-between text-xs text-muted-foreground">
                        <div className="flex items-center gap-1.5 font-mono">
                          <Clock className="h-3.5 w-3.5" />
                          {project.duration}
                        </div>
                        <div>
                          {new Date(project.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-3 top-4 z-10 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Delete ${project.name}`}
                  onClick={() => setProjectToDelete(project)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={Boolean(projectToDelete)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !deleteProject.isPending) setProjectToDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this project?</DialogTitle>
            <DialogDescription>
              This permanently removes the project, its arrangements, jobs, activity,
              exports, and private source audio. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {projectToDelete && (
            <div className="rounded-lg border bg-muted/40 px-4 py-3">
              <p className="font-semibold text-foreground">{projectToDelete.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Stored file cleanup is tracked and can be retried if storage is temporarily unavailable.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setProjectToDelete(null)}
              disabled={deleteProject.isPending}
            >
              Keep project
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteProject.isPending}
            >
              {deleteProject.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {deleteProject.isPending ? "Deleting..." : "Delete project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
