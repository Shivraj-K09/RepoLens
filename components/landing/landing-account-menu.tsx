"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import type { LandingAuthSnapshot } from "@/lib/auth/landing-auth";
import { cn } from "@/lib/utils";
import { LogOut } from "lucide-react";
import { useCallback } from "react";

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
  className?: string;
};

export function LandingAccountMenu({
  auth,
  className,
}: LandingAccountMenuProps) {
  const onSignOut = useCallback(() => {
    window.location.assign("/api/auth/signout");
  }, []);

  return (
    <div
      className={cn(
        "flex w-full min-w-0 items-center justify-between gap-2",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
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
        <span className="truncate text-[13px] font-medium text-sidebar-foreground">
          {auth.displayName}
        </span>
      </div>
      <Button
        type="button"
        variant="destructive"
        size="icon-sm"
        aria-label="Sign out"
        className="shrink-0"
        onClick={onSignOut}
      >
        <LogOut aria-hidden />
      </Button>
    </div>
  );
}
