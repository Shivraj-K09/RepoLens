"use client";

import dynamic from "next/dynamic";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Sparkles, XIcon } from "lucide-react";
import { createPortal } from "react-dom";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogOverlay,
  DialogPortal,
} from "@/components/ui/dialog";
import { Sidebar, SidebarContent } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const RepoRagChat = dynamic(
  () => import("@/components/repo/repo-rag-chat").then((m) => m.RepoRagChat),
  {
    loading: () => (
      <div className="space-y-2 p-3">
        <div className="h-8 w-full animate-pulse rounded-md bg-muted/40" />
        <div className="h-24 w-full animate-pulse rounded-md bg-muted/30" />
        <div className="h-24 w-full animate-pulse rounded-md bg-muted/30" />
      </div>
    ),
  },
);

export type RepoAiSidebarProps = {
  routeOwner: string;
  routeRepo: string;
  displayOwner: string;
  displayRepo: string;
  indexedCommitSha: string | null;
  className?: string;
};

/** Matches Tailwind `lg` — same breakpoint as the repo detail AI rail layout. */
const LG_MEDIA_QUERY = "(min-width: 1024px)";

function useBodyPortalTargetReady() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

function useLgBreakpointReady(): boolean | null {
  const [isLg, setIsLg] = useState<boolean | null>(null);

  useEffect(() => {
    const mq = window.matchMedia(LG_MEDIA_QUERY);
    const onChange = () => {
      setIsLg(mq.matches);
    };
    const raf = requestAnimationFrame(onChange);
    mq.addEventListener("change", onChange);
    return () => {
      cancelAnimationFrame(raf);
      mq.removeEventListener("change", onChange);
    };
  }, []);

  return isLg;
}

/**
 * Right-hand repository AI rail (shadcn Sidebar + {@link RepoRagChat}).
 * Below `lg`, the rail becomes a floating action that opens a **popup** anchored above the button (bottom-right), not a full-width sheet.
 */
export function RepoAiSidebar(props: RepoAiSidebarProps) {
  const isLg = useLgBreakpointReady();
  const [mobileOpen, setMobileOpen] = useState(false);
  const canPortalFab = useBodyPortalTargetReady();
  /** Used so Dialog “outside” dismiss does not also fire; see onPointerDownOutside below. */
  const fabLauncherRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const mq = window.matchMedia(LG_MEDIA_QUERY);
    const closeFloatingWhenCrossingToDesktop = () => {
      if (mq.matches) {
        setMobileOpen(false);
      }
    };
    mq.addEventListener("change", closeFloatingWhenCrossingToDesktop);
    return () =>
      mq.removeEventListener("change", closeFloatingWhenCrossingToDesktop);
  }, []);

  if (isLg === null) {
    return null;
  }

  if (isLg) {
    return (
      <Sidebar
        aria-label="Repository AI chat"
        data-repo-ai-rail="true"
        side="right"
        collapsible="none"
        className={cn(
          "flex min-h-0 shrink-0 flex-col overflow-hidden border-border text-foreground",
          "h-full min-h-0 w-[min(26.25rem,100%)] border-l",
          props.className,
        )}
        style={
          {
            ["--sidebar-width" as string]: "min(26.25rem, 100%)",
          } as CSSProperties
        }
      >
        <SidebarContent className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden p-0">
          <RepoRagChat
            key={`rag-chat:${props.routeOwner}:${props.routeRepo}`}
            routeOwner={props.routeOwner}
            routeRepo={props.routeRepo}
            displayOwner={props.displayOwner}
            displayRepo={props.displayRepo}
            indexedCommitSha={props.indexedCommitSha}
            className="min-h-0"
          />
        </SidebarContent>
      </Sidebar>
    );
  }

  const fabButton = (
    <Button
      ref={fabLauncherRef}
      type="button"
      size="icon"
      variant="default"
      className={cn(
        "pointer-events-auto fixed z-200 size-14 rounded-full shadow-md ring-1 ring-foreground/10",
        "bottom-[max(1rem,env(safe-area-inset-bottom))]",
        "right-[max(1rem,env(safe-area-inset-right))]",
      )}
      aria-expanded={mobileOpen}
      aria-controls="repo-ai-floating-panel"
      aria-label={
        mobileOpen ? "Close repository AI chat" : "Open repository AI chat"
      }
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMobileOpen((o) => !o);
      }}
    >
      <Sparkles className="size-6" aria-hidden />
    </Button>
  );

  return (
    <>
      {canPortalFab ? createPortal(fabButton, document.body) : null}

      {/*
        Non-modal: a portaled FAB must stay clickable to toggle the panel closed.
        Modal dialogs mark outside layers inert, which blocks the launcher.
      */}
      <Dialog open={mobileOpen} onOpenChange={setMobileOpen} modal={false}>
        <DialogPortal>
          <DialogOverlay className="z-90" />
          <DialogPrimitive.Content
            id="repo-ai-floating-panel"
            forceMount
            onCloseAutoFocus={(e) => {
              // No Radix “trigger”; avoid focus quirks with a portaled launcher.
              e.preventDefault();
            }}
            onPointerDownOutside={(e) => {
              const t = e.target as Node | null;
              if (t && fabLauncherRef.current?.contains(t)) {
                e.preventDefault();
              }
            }}
            onInteractOutside={(e) => {
              const t = e.target as Node | null;
              if (t && fabLauncherRef.current?.contains(t)) {
                e.preventDefault();
              }
            }}
            className={cn(
              "fixed z-95 flex flex-col overflow-hidden rounded-2xl border border-border bg-popover text-sm text-popover-foreground shadow-xl outline-none duration-100",
              // Anchor to bottom-right above the FAB (size-14 + gap), not screen center or left edge
              "top-auto left-auto translate-x-0 translate-y-0",
              "bottom-[calc(max(1rem,env(safe-area-inset-bottom,0))+3.5rem+0.75rem)]",
              "right-[max(1rem,env(safe-area-inset-right))]",
              "h-[min(32rem,85dvh)] max-h-[85dvh] w-[min(26.25rem,calc(100vw-2rem))] max-w-105 gap-0 border-border p-0",
              "origin-bottom-right",
              "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
              "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              props.className,
            )}
          >
            <DialogPrimitive.Title className="sr-only">
              Repository AI chat
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Ask questions about this repository using the indexed code and
              docs.
            </DialogPrimitive.Description>
            <DialogPrimitive.Close asChild>
              <Button
                type="button"
                variant="ghost"
                className="absolute top-3 right-3 z-10"
                size="icon-sm"
              >
                <XIcon />
                <span className="sr-only">Close</span>
              </Button>
            </DialogPrimitive.Close>
            <div
              aria-label="Repository AI chat"
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl"
              data-repo-ai-rail="true"
            >
              <RepoRagChat
                key={`rag-chat:${props.routeOwner}:${props.routeRepo}`}
                routeOwner={props.routeOwner}
                routeRepo={props.routeRepo}
                displayOwner={props.displayOwner}
                displayRepo={props.displayRepo}
                indexedCommitSha={props.indexedCommitSha}
                className="min-h-0"
                surface="floating"
              />
            </div>
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    </>
  );
}
