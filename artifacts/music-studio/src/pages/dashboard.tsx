import { useGetDashboard } from "@workspace/api-client-react";
import { Link } from "wouter";
import { 
  Activity, 
  ArrowRight,
  Disc3, 
  AudioWaveform, 
  Save, 
  Play, 
  BarChart, 
  Music,
  Plus
} from "lucide-react";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty";

export default function Dashboard() {
  const { data: dashboard, isLoading, error } = useGetDashboard();

  if (error) {
    return (
      <div className="p-6 md:p-10 max-w-6xl mx-auto flex items-center justify-center min-h-[50vh]">
        <div className="text-center">
          <div className="bg-destructive/10 text-destructive p-3 rounded-full w-fit mx-auto mb-4">
            <Activity className="h-8 w-8" />
          </div>
          <h2 className="text-xl font-bold text-foreground">Unable to load dashboard</h2>
          <p className="text-muted-foreground mt-2 max-w-sm">
            There was a problem connecting to the studio services. Please try again.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-10 max-w-6xl mx-auto space-y-8 pb-20">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Overview</h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Welcome back to your studio. Here's what's happening.
          </p>
        </div>
        <Link href="/projects">
          <Button className="shadow-sm shadow-primary/20 cursor-pointer">
            <Plus className="mr-2 h-4 w-4" />
            New Project
          </Button>
        </Link>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="shadow-sm border-t-4 border-t-primary">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Active Projects
            </CardTitle>
            <div className="p-2 bg-primary/10 rounded-md text-primary">
              <Disc3 className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-3xl font-bold font-mono text-foreground">
                {dashboard?.activeProjects.toString().padStart(2, '0') || "00"}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm border-t-4 border-t-blue-500">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Total Renders
            </CardTitle>
            <div className="p-2 bg-blue-500/10 rounded-md text-blue-500">
              <AudioWaveform className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-3xl font-bold font-mono text-foreground">
                {dashboard?.totalRenders.toLocaleString() || "0"}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm border-t-4 border-t-green-500">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Saved Artifacts
            </CardTitle>
            <div className="p-2 bg-green-500/10 rounded-md text-green-500">
              <Save className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-3xl font-bold font-mono text-foreground">
                {dashboard?.savedArtifacts.toLocaleString() || "0"}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-8">
        <Card className="shadow-sm overflow-hidden flex flex-col h-full">
          <CardHeader className="border-b bg-muted/20 pb-4">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">Recent Activity</CardTitle>
                <CardDescription>Actions performed across your projects</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0 flex-1 flex flex-col min-h-0">
            {isLoading ? (
              <div className="divide-y">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="flex items-center gap-4 p-4">
                    <Skeleton className="h-10 w-10 rounded-full" />
                    <div className="space-y-2 flex-1">
                      <Skeleton className="h-4 w-1/3" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : !dashboard?.recentActivity?.length ? (
              <EmptyState 
                icon={Activity} 
                title="No activity yet" 
                description="Start analyzing and arranging songs to see activity here."
                className="py-12"
              />
            ) : (
              <div className="divide-y overflow-auto flex-1">
                {dashboard.recentActivity.map((activity) => (
                  <div key={activity.id} className="flex items-start gap-4 p-5 hover:bg-muted/30 transition-colors group">
                    <div className="mt-0.5">
                      {activity.type === 'analysis' && (
                        <div className="p-2 bg-purple-500/10 rounded-full text-purple-600 dark:text-purple-400 ring-1 ring-purple-500/20">
                          <BarChart className="h-4 w-4" />
                        </div>
                      )}
                      {activity.type === 'arrangement' && (
                        <div className="p-2 bg-blue-500/10 rounded-full text-blue-600 dark:text-blue-400 ring-1 ring-blue-500/20">
                          <Music className="h-4 w-4" />
                        </div>
                      )}
                      {activity.type === 'render' && (
                        <div className="p-2 bg-primary/10 rounded-full text-primary ring-1 ring-primary/20">
                          <Play className="h-4 w-4" />
                        </div>
                      )}
                      {activity.type === 'export' && (
                        <div className="p-2 bg-green-500/10 rounded-full text-green-600 dark:text-green-400 ring-1 ring-green-500/20">
                          <Save className="h-4 w-4" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <p className="text-sm font-semibold text-foreground truncate">
                          {activity.title}
                        </p>
                        <time className="text-xs text-muted-foreground whitespace-nowrap font-mono">
                          {new Date(activity.time).toLocaleDateString(undefined, { 
                            month: 'short', 
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit'
                          })}
                        </time>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {activity.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
          <div className="p-4 border-t bg-muted/20">
            <Link href="/projects">
              <Button variant="ghost" className="w-full text-muted-foreground hover:text-foreground cursor-pointer">
                View All Projects <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
