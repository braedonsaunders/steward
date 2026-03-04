"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Server,
  AlertTriangle,
  MessageSquare,
  Activity,
  Settings,
  Shield,
  Menu,
  CheckSquare,
  ShieldCheck,
  FileText,
  Network,
  Puzzle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/theme-toggle";
import { StewardProvider, useSteward } from "@/lib/hooks/use-steward";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/devices", label: "Devices", icon: Server },
  { href: "/incidents", label: "Incidents", icon: AlertTriangle },
  { href: "/approvals", label: "Approvals", icon: CheckSquare },
  { href: "/policies", label: "Policies", icon: ShieldCheck },
  { href: "/digest", label: "Digest", icon: FileText },
  { href: "/topology", label: "Topology", icon: Network },
  { href: "/plugins", label: "Plugins", icon: Puzzle },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  badge,
  onClick,
}: {
  href: string;
  label: string;
  icon: React.ElementType;
  active: boolean;
  badge?: number;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-primary/10 text-primary"
          : "text-sidebar-foreground/70 hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
      {badge != null && badge > 0 && (
        <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-xs font-medium text-destructive-foreground">
          {badge}
        </span>
      )}
    </Link>
  );
}

function VaultIndicator() {
  const { vaultStatus } = useSteward();
  if (!vaultStatus) return null;

  const locked = !vaultStatus.unlocked;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-2 text-xs",
        locked ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <Shield className="h-3.5 w-3.5" />
      <span>
        Vault: {vaultStatus.initialized ? (locked ? "Locked" : "Unlocked") : "Not initialized"}
      </span>
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { overview } = useSteward();

  const getBadge = (href: string) => {
    if (href === "/incidents") return overview.incidents;
    if (href === "/approvals") return overview.pendingApprovals;
    return undefined;
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-sidebar-border px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Shield className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <h1 className="text-sm font-semibold text-sidebar-foreground">Steward</h1>
          <p className="text-[10px] leading-tight text-muted-foreground">Network Operations</p>
        </div>
        <ThemeToggle />
      </div>

      <nav className="flex-1 space-y-1 px-3 py-3">
        {navItems.map((item) => (
          <NavLink
            key={item.href}
            href={item.href}
            label={item.label}
            icon={item.icon}
            active={
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href)
            }
            badge={getBadge(item.href)}
            onClick={onNavigate}
          />
        ))}
      </nav>

      <div className="border-t border-sidebar-border px-3 py-3">
        <VaultIndicator />
      </div>
    </div>
  );
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      {/* Desktop sidebar */}
      <aside className="relative z-20 hidden h-full w-[220px] shrink-0 border-r border-sidebar-border bg-sidebar md:block">
        <SidebarContent />
      </aside>

      {/* Mobile sidebar */}
      <Sheet open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2 border-b bg-sidebar px-4 py-3 md:hidden">
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <Menu className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <span className="text-sm font-semibold">Steward</span>
        </div>
        <SheetContent side="left" className="w-[220px] bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarContent onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>

      {/* Main content */}
      <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
        <div className="flex h-full min-h-0 w-full flex-col overflow-hidden px-4 py-4 md:px-6 md:py-6 lg:px-8">
          {children}
        </div>
      </main>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <StewardProvider>
      <ShellInner>{children}</ShellInner>
    </StewardProvider>
  );
}
