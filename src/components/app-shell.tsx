"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  LayoutDashboard,
  Server,
  AlertTriangle,
  MessageSquare,
  Activity,
  Search,
  Settings,
  Shield,
  Menu,
  CheckSquare,
  ShieldCheck,
  FileText,
  Network,
  Puzzle,
  UserRoundCog,
  Bot,
  Package2,
  Send,
  Target,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/theme-toggle";
import { ChatRuntimeProvider } from "@/lib/hooks/use-chat-runtime";
import { StewardProvider, useSteward } from "@/lib/hooks/use-steward";
import { navItemVariants, pageVariants, quickSpring, staggerContainerVariants } from "@/lib/motion";

type NavItem = {
  href: string;
  label: string;
  icon: React.ElementType;
};

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/digest", label: "Digest", icon: FileText },
    ],
  },
  {
    label: "Network",
    items: [
      { href: "/devices", label: "Devices", icon: Server },
      { href: "/discovery", label: "Discovery", icon: Search },
      { href: "/topology", label: "Topology", icon: Network },
    ],
  },
  {
    label: "Health",
    items: [
      { href: "/incidents", label: "Incidents", icon: AlertTriangle },
      { href: "/activity", label: "Activity", icon: Activity },
    ],
  },
  {
    label: "Control",
    items: [
      { href: "/approvals", label: "Approvals", icon: CheckSquare },
      { href: "/policies", label: "Policies", icon: ShieldCheck },
    ],
  },
  {
    label: "Autonomy",
    items: [
      { href: "/missions", label: "Missions", icon: Target },
      { href: "/subagents", label: "Subagents", icon: Bot },
      { href: "/packs", label: "Packs", icon: Package2 },
      { href: "/gateway", label: "Gateway", icon: Send },
    ],
  },
  {
    label: "Assistant",
    items: [{ href: "/chat", label: "Chat", icon: MessageSquare }],
  },
  {
    label: "System",
    items: [
      { href: "/adapters", label: "Adapters", icon: Puzzle },
      { href: "/access", label: "Access", icon: UserRoundCog },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
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
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      variants={reduceMotion ? undefined : navItemVariants}
      whileHover={reduceMotion ? undefined : { x: 2 }}
      whileTap={reduceMotion ? undefined : { scale: 0.99 }}
    >
      <Link
        href={href}
        onClick={onClick}
        className={cn(
          "steward-sidebar-font relative flex items-center gap-3 overflow-hidden rounded-lg px-3 py-2 text-[0.92rem] font-medium transition-[color,background-color]",
          active
            ? "bg-primary/12 text-sidebar-foreground"
            : "text-sidebar-foreground/66 hover:bg-sidebar-foreground/[0.045] hover:text-sidebar-foreground",
        )}
      >
        {active && (
          <motion.span
            layoutId="active-nav-pill"
            className="absolute inset-0 rounded-lg bg-primary/10"
            transition={quickSpring}
          />
        )}
        <span className="relative z-10 flex min-w-0 flex-1 items-center gap-3">
          <Icon className="h-4 w-4 shrink-0" />
          <span className="truncate">{label}</span>
        </span>
        <AnimatePresence initial={false} mode="popLayout">
          {badge != null && badge > 0 ? (
            <motion.span
              key={`${href}-${badge}`}
              initial={reduceMotion ? undefined : { scale: 0.75, opacity: 0, y: 4 }}
              animate={reduceMotion ? undefined : { scale: 1, opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { scale: 0.75, opacity: 0, y: -4 }}
              transition={quickSpring}
              className="relative z-10 ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-xs font-medium text-destructive-foreground"
            >
              {badge}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </Link>
    </motion.div>
  );
}

function VaultIndicator() {
  const { vaultStatus } = useSteward();
  const reduceMotion = useReducedMotion();
  if (!vaultStatus) return null;

  const locked = !vaultStatus.unlocked;
  const stateLabel = vaultStatus.initialized ? (locked ? "Locked" : "Unlocked") : "Not initialized";

  return (
    <motion.div
      layout
      className={cn(
        "flex items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-foreground/[0.025] px-3 py-2 text-[0.68rem] font-medium uppercase tracking-[0.14em]",
        locked ? "text-destructive" : "text-muted-foreground",
      )}
      transition={quickSpring}
    >
      <Shield className="h-3.5 w-3.5" />
      <AnimatePresence initial={false} mode="wait">
        <motion.span
          key={stateLabel}
          initial={reduceMotion ? undefined : { y: 4, opacity: 0 }}
          animate={reduceMotion ? undefined : { y: 0, opacity: 1 }}
          exit={reduceMotion ? undefined : { y: -4, opacity: 0 }}
          transition={quickSpring}
        >
          Vault: {stateLabel}
        </motion.span>
      </AnimatePresence>
    </motion.div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { overview } = useSteward();
  const reduceMotion = useReducedMotion();
  const layoutGroupId = onNavigate ? "mobile-sidebar-nav" : "desktop-sidebar-nav";
  const isRouteActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  const getBadge = (href: string) => {
    if (href === "/incidents") return overview.incidents;
    if (href === "/approvals") return overview.pendingApprovals;
    return undefined;
  };

  return (
    <div className="flex h-full flex-col">
      <motion.div
        className="flex items-center gap-3 border-b border-sidebar-border/80 px-4 py-4"
        initial={reduceMotion ? undefined : { opacity: 0, y: -8 }}
        animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
        transition={quickSpring}
      >
        <motion.div
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary"
          whileHover={reduceMotion ? undefined : { rotate: -8, scale: 1.05 }}
          transition={quickSpring}
        >
          <Shield className="h-4 w-4" />
        </motion.div>
        <div className="flex-1">
          <h1 className="steward-sidebar-font text-[1.02rem] font-semibold text-sidebar-foreground">Steward</h1>
          <p className="text-[0.74rem] leading-tight text-muted-foreground">Network operations</p>
        </div>
        <ThemeToggle />
      </motion.div>

      <LayoutGroup id={layoutGroupId}>
        <motion.nav
          className="flex-1 space-y-4 overflow-y-auto px-3 py-3"
          variants={reduceMotion ? undefined : staggerContainerVariants}
          initial={reduceMotion ? undefined : "initial"}
          animate={reduceMotion ? undefined : "animate"}
        >
          {navGroups.map((group) => (
            <section key={group.label} className="space-y-1">
              <p className="px-3 pb-1 text-[0.62rem] font-semibold tracking-[0.12em] text-sidebar-foreground/42 uppercase">
                {group.label}
              </p>
              {group.items.map((item) => (
                <NavLink
                  key={item.href}
                  href={item.href}
                  label={item.label}
                  icon={item.icon}
                  active={isRouteActive(item.href)}
                  badge={getBadge(item.href)}
                  onClick={onNavigate}
                />
              ))}
            </section>
          ))}
        </motion.nav>
      </LayoutGroup>

      <motion.div
        className="border-t border-sidebar-border/80 px-3 py-3"
        initial={reduceMotion ? undefined : { opacity: 0 }}
        animate={reduceMotion ? undefined : { opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.16 }}
      >
        <VaultIndicator />
      </motion.div>
    </div>
  );
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const { authRequired } = useSteward();
  const isEdgeToEdgeRoute = pathname === "/chat";
  const isCompactDetailRoute = /^\/devices\/[^/]+$/.test(pathname);

  useEffect(() => {
    if (!authRequired || pathname === "/access") {
      return;
    }
    const next = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
    router.replace(`/access${next}`);
  }, [authRequired, pathname, router]);

  const pageMotionProps = reduceMotion
    ? {
        initial: { opacity: 1 },
        animate: { opacity: 1 },
        exit: { opacity: 1 },
      }
    : {
        variants: pageVariants,
        initial: "initial" as const,
        animate: "animate" as const,
        exit: "exit" as const,
      };

  if (authRequired && pathname !== "/access") {
    return (
      <main className="flex h-dvh items-center justify-center bg-background p-6">
        <div className="max-w-sm rounded-xl border bg-card p-6 text-center">
          <h1 className="steward-heading-font text-lg font-semibold">Authentication Required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Redirecting to Access so you can sign in and restore the live Steward session.
          </p>
        </div>
      </main>
    );
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      {/* Desktop sidebar */}
      <motion.aside
        className="relative z-20 hidden h-full w-[var(--steward-sidebar-width)] shrink-0 border-r border-sidebar-border bg-sidebar md:block"
        initial={reduceMotion ? undefined : { x: -18, opacity: 0 }}
        animate={reduceMotion ? undefined : { x: 0, opacity: 1 }}
        transition={{ ...quickSpring, delay: 0.04 }}
      >
        <SidebarContent />
      </motion.aside>

      {/* Mobile sidebar */}
      <Sheet open={open} onOpenChange={setOpen}>
        <motion.div
          className="flex items-center gap-2 border-b border-sidebar-border bg-sidebar px-4 py-3 md:hidden"
          initial={reduceMotion ? undefined : { y: -10, opacity: 0 }}
          animate={reduceMotion ? undefined : { y: 0, opacity: 1 }}
          transition={quickSpring}
        >
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full">
              <Menu className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <span className="steward-sidebar-font text-sm font-semibold">Steward</span>
        </motion.div>
        <SheetContent side="left" className="w-[var(--steward-sidebar-width)] bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarContent onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>

      {/* Main content */}
      <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
        <div
          className={cn(
            "relative z-10 mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-col overflow-hidden",
            isEdgeToEdgeRoute
              ? "px-0 py-0"
              : isCompactDetailRoute
                ? "px-3 py-3 md:px-4 md:py-4 lg:px-5"
                : "px-4 py-4 md:px-6 md:py-6 lg:px-8",
          )}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={pathname}
              className="flex h-full min-h-0 w-full flex-col overflow-hidden"
              {...pageMotionProps}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <StewardProvider>
      <ChatRuntimeProvider>
        <ShellInner>{children}</ShellInner>
      </ChatRuntimeProvider>
    </StewardProvider>
  );
}
