import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { 
  Music, 
  LayoutDashboard, 
  Library,
  Settings,
  Menu,
  Package
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface ShellProps {
  children: ReactNode;
}

export function Shell({ children }: ShellProps) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/projects", label: "Projects", icon: Library },
    { href: "/instrument-packs", label: "Instrument Packs", icon: Package },
  ];

  const NavLinks = ({ className }: { className?: string }) => (
    <nav className={cn("space-y-1 py-4", className)}>
      {navItems.map((item) => {
        const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
        return (
          <Link key={item.href} href={item.href}>
            <div
              className={cn(
                "flex items-center gap-3 px-4 py-2.5 mx-3 rounded-md text-sm font-medium transition-colors cursor-pointer",
                isActive 
                  ? "bg-primary text-primary-foreground shadow-xs shadow-primary/20" 
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </div>
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen w-full flex flex-col md:flex-row bg-background">
      {/* Mobile Header */}
      <header className="md:hidden flex items-center justify-between px-4 h-14 border-b bg-card">
        <div className="flex items-center gap-2 font-bold text-foreground">
          <div className="bg-primary p-1.5 rounded-md">
            <Music className="h-4 w-4 text-primary-foreground" />
          </div>
          Studio AI
        </div>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[240px] p-0 border-r-0">
            <div className="flex items-center gap-2 font-bold text-foreground px-6 h-14 border-b">
              <div className="bg-primary p-1.5 rounded-md">
                <Music className="h-4 w-4 text-primary-foreground" />
              </div>
              Studio AI
            </div>
            <NavLinks />
          </SheetContent>
        </Sheet>
      </header>

      {/* Desktop Sidebar */}
      <aside className="hidden md:flex flex-col w-64 border-r bg-sidebar h-screen sticky top-0 shrink-0 shadow-sm z-10">
        <div className="flex items-center gap-2 font-bold text-lg text-sidebar-foreground px-6 h-16 border-b">
          <div className="bg-primary p-1.5 rounded-md shadow-sm">
            <Music className="h-5 w-5 text-primary-foreground" />
          </div>
          Studio AI
        </div>
        <div className="flex-1 overflow-auto">
          <NavLinks />
        </div>
        <div className="p-4 border-t border-sidebar-border mt-auto">
          <Button variant="ghost" className="w-full justify-start text-muted-foreground hover:text-foreground">
            <Settings className="h-4 w-4 mr-2" />
            Preferences
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 h-[calc(100vh-3.5rem)] md:h-screen overflow-auto">
        <div className="flex-1">
          {children}
        </div>
      </main>
    </div>
  );
}
