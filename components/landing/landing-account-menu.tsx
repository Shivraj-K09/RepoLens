"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LandingAuthSnapshot } from "@/lib/auth/landing-auth";
import { cn } from "@/lib/utils";
import { LogOut } from "lucide-react";

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const a = parts[0]?.[0];
    const b = parts[parts.length - 1]?.[0];
    const out = `${a ?? ""}${b ?? ""}`.toUpperCase();
    return out || "UU";
  }
  return name.slice(0, 2).toUpperCase() || "UU";
}

type LandingAccountMenuProps = {
  auth: LandingAuthSnapshot;
  /** True when the desktop sidebar is collapsed to the icon rail. */
  compactRail?: boolean;
  className?: string;
};

export function LandingAccountMenu({
  auth,
  compactRail = false,
  className,
}: LandingAccountMenuProps) {
  if (!compactRail) {
    return (
      <div
        className={cn(
          "flex h-11 min-h-11 w-full min-w-0 items-center justify-between gap-2 px-0.5",
          className,
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Avatar size="sm" className="size-8 shrink-0">
            {auth.avatarUrl ? (
              <AvatarImage
                src={auth.avatarUrl}
                alt=""
                referrerPolicy="no-referrer"
              />
            ) : null}
            <AvatarFallback className="text-[11px] font-medium">
              {initialsFromName(auth.displayName)}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 truncate text-[13px] font-medium text-sidebar-foreground">
            {auth.displayName}
          </span>
        </div>
        <form
          action="/api/auth/signout"
          method="post"
          className="contents"
        >
          <Button
            type="submit"
            variant="destructive"
            size="icon-sm"
            aria-label="Sign out"
            className="shrink-0"
          >
            <LogOut aria-hidden />
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex h-11 min-h-11 w-full min-w-0 items-center justify-center",
        className,
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md outline-hidden",
              "ring-offset-background transition-colors hover:bg-sidebar-accent/75 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2",
            )}
            aria-label="Account menu"
          >
            <Avatar size="sm" className="size-8 shrink-0">
              {auth.avatarUrl ? (
                <AvatarImage
                  src={auth.avatarUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                />
              ) : null}
              <AvatarFallback className="text-[11px] font-medium">
                {initialsFromName(auth.displayName)}
              </AvatarFallback>
            </Avatar>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="right"
          sideOffset={8}
          className="w-56 rounded-lg p-0"
        >
          <div className="flex items-center gap-2.5 border-border border-b px-3 py-2.5">
            <Avatar size="sm" className="shrink-0">
              {auth.avatarUrl ? (
                <AvatarImage
                  src={auth.avatarUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                />
              ) : null}
              <AvatarFallback className="text-[11px] font-medium">
                {initialsFromName(auth.displayName)}
              </AvatarFallback>
            </Avatar>
            <span className="truncate text-sm font-medium leading-snug">
              {auth.displayName}
            </span>
          </div>
          <DropdownMenuSeparator className="m-0" />
          <div className="p-1">
            <DropdownMenuItem
              variant="destructive"
              className="cursor-pointer gap-2"
              onSelect={(event) => {
                event.preventDefault();
                const form =
                  typeof document !== "undefined"
                    ? document.getElementById("landing-sidebar-signout")
                    : null;
                if (form instanceof HTMLFormElement) {
                  form.requestSubmit();
                }
              }}
            >
              <LogOut className="size-4" aria-hidden />
              Log out
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <form
        id="landing-sidebar-signout"
        action="/api/auth/signout"
        method="post"
        className="hidden"
        aria-hidden
      />
    </div>
  );
}
