"use client";

import { AlertTriangle, Pencil, Plus, StickyNote, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type RepoNotesTabProps = {
  routeOwner: string;
  routeRepo: string;
};

type NoteRow = {
  id: string;
  title: string;
  body: string;
  color_index: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

const NOTE_BODY_MAX = 500;
const NOTE_TITLE_MAX = 120;
const COLOR_COUNT = 10;

/** Must match `sticky-tear-slice-*` duration in `app/globals.css`. */
const NOTE_TEAR_OFF_MS = 720;

/** Sticky note skins — grid cards use `card`; editor uses soft `dialogTint` on neutral shell + `field` for tint-aware inputs. */
const STICKY_PALETTE: {
  card: string;
  tape: string;
  swatch: string;
  field: string;
  dialogTint: string;
}[] = [
  {
    card: "border-black/12 bg-[#fff8dc] text-amber-950 shadow-[2px_3px_0_rgba(0,0,0,0.07),6px_16px_32px_rgba(0,0,0,0.14)] dark:border-amber-400/35 dark:bg-amber-950 dark:text-amber-50 dark:shadow-[2px_3px_0_rgba(0,0,0,0.35),6px_18px_36px_rgba(0,0,0,0.55)]",
    tape: "bg-amber-200/95 shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-amber-300/88",
    swatch:
      "border-amber-800/25 bg-[#fff8dc] dark:border-amber-300/45 dark:bg-amber-800/78",
    field:
      "border-amber-900/40 bg-white/90 text-amber-950 placeholder:text-amber-950/48 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] focus-visible:border-amber-800 focus-visible:ring-[3px] focus-visible:ring-amber-600/32 dark:border-amber-200/32 dark:bg-black/38 dark:text-amber-50 dark:placeholder:text-amber-100/58 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)] dark:focus-visible:border-amber-200 dark:focus-visible:ring-amber-400/38",
    dialogTint:
      "bg-linear-to-b from-amber-500/[0.045] via-transparent to-transparent dark:from-amber-400/[0.055]",
  },
  {
    card: "border-rose-900/14 bg-[#ffe4e8] text-rose-950 shadow-[2px_3px_0_rgba(0,0,0,0.07),6px_16px_32px_rgba(0,0,0,0.14)] dark:border-rose-400/35 dark:bg-rose-950 dark:text-rose-50 dark:shadow-[2px_3px_0_rgba(0,0,0,0.35),6px_18px_36px_rgba(0,0,0,0.55)]",
    tape: "bg-rose-200/95 shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-rose-300/85",
    swatch:
      "border-rose-800/25 bg-[#ffe4e8] dark:border-rose-300/45 dark:bg-rose-800/78",
    field:
      "border-rose-900/40 bg-white/90 text-rose-950 placeholder:text-rose-950/48 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] focus-visible:border-rose-800 focus-visible:ring-[3px] focus-visible:ring-rose-600/32 dark:border-rose-200/32 dark:bg-black/38 dark:text-rose-50 dark:placeholder:text-rose-100/58 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)] dark:focus-visible:border-rose-200 dark:focus-visible:ring-rose-400/38",
    dialogTint:
      "bg-linear-to-b from-rose-500/[0.045] via-transparent to-transparent dark:from-rose-400/[0.055]",
  },
  {
    card: "border-sky-900/14 bg-[#dbeafe] text-sky-950 shadow-[2px_3px_0_rgba(0,0,0,0.07),6px_16px_32px_rgba(0,0,0,0.14)] dark:border-sky-400/35 dark:bg-sky-950 dark:text-sky-50 dark:shadow-[2px_3px_0_rgba(0,0,0,0.35),6px_18px_36px_rgba(0,0,0,0.55)]",
    tape: "bg-sky-200/95 shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-sky-300/85",
    swatch:
      "border-sky-800/25 bg-[#dbeafe] dark:border-sky-300/45 dark:bg-sky-800/78",
    field:
      "border-sky-900/40 bg-white/90 text-sky-950 placeholder:text-sky-950/48 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] focus-visible:border-sky-800 focus-visible:ring-[3px] focus-visible:ring-sky-600/32 dark:border-sky-200/32 dark:bg-black/38 dark:text-sky-50 dark:placeholder:text-sky-100/58 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)] dark:focus-visible:border-sky-200 dark:focus-visible:ring-sky-400/38",
    dialogTint:
      "bg-linear-to-b from-sky-500/[0.045] via-transparent to-transparent dark:from-sky-400/[0.055]",
  },
  {
    card: "border-lime-900/14 bg-[#ecfccb] text-lime-950 shadow-[2px_3px_0_rgba(0,0,0,0.07),6px_16px_32px_rgba(0,0,0,0.14)] dark:border-lime-400/35 dark:bg-lime-950 dark:text-lime-50 dark:shadow-[2px_3px_0_rgba(0,0,0,0.35),6px_18px_36px_rgba(0,0,0,0.55)]",
    tape: "bg-lime-200/95 shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-lime-300/85",
    swatch:
      "border-lime-800/25 bg-[#ecfccb] dark:border-lime-300/45 dark:bg-lime-800/78",
    field:
      "border-lime-900/40 bg-white/90 text-lime-950 placeholder:text-lime-950/48 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] focus-visible:border-lime-800 focus-visible:ring-[3px] focus-visible:ring-lime-600/32 dark:border-lime-200/32 dark:bg-black/38 dark:text-lime-50 dark:placeholder:text-lime-100/58 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)] dark:focus-visible:border-lime-200 dark:focus-visible:ring-lime-400/38",
    dialogTint:
      "bg-linear-to-b from-lime-500/[0.045] via-transparent to-transparent dark:from-lime-400/[0.055]",
  },
  {
    card: "border-violet-900/14 bg-[#ede9fe] text-violet-950 shadow-[2px_3px_0_rgba(0,0,0,0.07),6px_16px_32px_rgba(0,0,0,0.14)] dark:border-violet-400/35 dark:bg-violet-950 dark:text-violet-50 dark:shadow-[2px_3px_0_rgba(0,0,0,0.35),6px_18px_36px_rgba(0,0,0,0.55)]",
    tape: "bg-violet-200/95 shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-violet-300/85",
    swatch:
      "border-violet-800/25 bg-[#ede9fe] dark:border-violet-300/45 dark:bg-violet-800/78",
    field:
      "border-violet-900/40 bg-white/90 text-violet-950 placeholder:text-violet-950/48 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] focus-visible:border-violet-800 focus-visible:ring-[3px] focus-visible:ring-violet-600/32 dark:border-violet-200/32 dark:bg-black/38 dark:text-violet-50 dark:placeholder:text-violet-100/58 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)] dark:focus-visible:border-violet-200 dark:focus-visible:ring-violet-400/38",
    dialogTint:
      "bg-linear-to-b from-violet-500/[0.045] via-transparent to-transparent dark:from-violet-400/[0.055]",
  },
  {
    card: "border-orange-900/14 bg-[#ffedd5] text-orange-950 shadow-[2px_3px_0_rgba(0,0,0,0.07),6px_16px_32px_rgba(0,0,0,0.14)] dark:border-orange-400/35 dark:bg-orange-950 dark:text-orange-50 dark:shadow-[2px_3px_0_rgba(0,0,0,0.35),6px_18px_36px_rgba(0,0,0,0.55)]",
    tape: "bg-orange-200/95 shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-orange-300/85",
    swatch:
      "border-orange-800/25 bg-[#ffedd5] dark:border-orange-300/45 dark:bg-orange-800/78",
    field:
      "border-orange-900/40 bg-white/90 text-orange-950 placeholder:text-orange-950/48 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] focus-visible:border-orange-800 focus-visible:ring-[3px] focus-visible:ring-orange-600/32 dark:border-orange-200/32 dark:bg-black/38 dark:text-orange-50 dark:placeholder:text-orange-100/58 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)] dark:focus-visible:border-orange-200 dark:focus-visible:ring-orange-400/38",
    dialogTint:
      "bg-linear-to-b from-orange-500/[0.045] via-transparent to-transparent dark:from-orange-400/[0.055]",
  },
  {
    card: "border-teal-900/14 bg-[#ccfbf1] text-teal-950 shadow-[2px_3px_0_rgba(0,0,0,0.07),6px_16px_32px_rgba(0,0,0,0.14)] dark:border-teal-400/35 dark:bg-teal-950 dark:text-teal-50 dark:shadow-[2px_3px_0_rgba(0,0,0,0.35),6px_18px_36px_rgba(0,0,0,0.55)]",
    tape: "bg-teal-200/95 shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-teal-300/85",
    swatch:
      "border-teal-800/25 bg-[#ccfbf1] dark:border-teal-300/45 dark:bg-teal-800/78",
    field:
      "border-teal-900/40 bg-white/90 text-teal-950 placeholder:text-teal-950/48 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] focus-visible:border-teal-800 focus-visible:ring-[3px] focus-visible:ring-teal-600/32 dark:border-teal-200/32 dark:bg-black/38 dark:text-teal-50 dark:placeholder:text-teal-100/58 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)] dark:focus-visible:border-teal-200 dark:focus-visible:ring-teal-400/38",
    dialogTint:
      "bg-linear-to-b from-teal-500/[0.045] via-transparent to-transparent dark:from-teal-400/[0.055]",
  },
  {
    card: "border-fuchsia-900/14 bg-[#fae8ff] text-fuchsia-950 shadow-[2px_3px_0_rgba(0,0,0,0.07),6px_16px_32px_rgba(0,0,0,0.14)] dark:border-fuchsia-400/35 dark:bg-fuchsia-950 dark:text-fuchsia-50 dark:shadow-[2px_3px_0_rgba(0,0,0,0.35),6px_18px_36px_rgba(0,0,0,0.55)]",
    tape: "bg-fuchsia-200/95 shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-fuchsia-300/85",
    swatch:
      "border-fuchsia-800/25 bg-[#fae8ff] dark:border-fuchsia-300/45 dark:bg-fuchsia-800/78",
    field:
      "border-fuchsia-900/40 bg-white/90 text-fuchsia-950 placeholder:text-fuchsia-950/48 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] focus-visible:border-fuchsia-800 focus-visible:ring-[3px] focus-visible:ring-fuchsia-600/32 dark:border-fuchsia-200/32 dark:bg-black/38 dark:text-fuchsia-50 dark:placeholder:text-fuchsia-100/58 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)] dark:focus-visible:border-fuchsia-200 dark:focus-visible:ring-fuchsia-400/38",
    dialogTint:
      "bg-linear-to-b from-fuchsia-500/[0.045] via-transparent to-transparent dark:from-fuchsia-400/[0.055]",
  },
  {
    card: "border-emerald-900/14 bg-[#d1fae5] text-emerald-950 shadow-[2px_3px_0_rgba(0,0,0,0.07),6px_16px_32px_rgba(0,0,0,0.14)] dark:border-emerald-400/35 dark:bg-emerald-950 dark:text-emerald-50 dark:shadow-[2px_3px_0_rgba(0,0,0,0.35),6px_18px_36px_rgba(0,0,0,0.55)]",
    tape: "bg-emerald-200/95 shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-emerald-300/85",
    swatch:
      "border-emerald-800/25 bg-[#d1fae5] dark:border-emerald-300/45 dark:bg-emerald-800/78",
    field:
      "border-emerald-900/40 bg-white/90 text-emerald-950 placeholder:text-emerald-950/48 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] focus-visible:border-emerald-800 focus-visible:ring-[3px] focus-visible:ring-emerald-600/32 dark:border-emerald-200/32 dark:bg-black/38 dark:text-emerald-50 dark:placeholder:text-emerald-100/58 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)] dark:focus-visible:border-emerald-200 dark:focus-visible:ring-emerald-400/38",
    dialogTint:
      "bg-linear-to-b from-emerald-500/[0.045] via-transparent to-transparent dark:from-emerald-400/[0.055]",
  },
  {
    card: "border-slate-700/18 bg-[#e8f0f5] text-slate-900 shadow-[2px_3px_0_rgba(0,0,0,0.07),6px_16px_32px_rgba(0,0,0,0.14)] dark:border-slate-400/30 dark:bg-slate-900 dark:text-slate-50 dark:shadow-[2px_3px_0_rgba(0,0,0,0.35),6px_18px_36px_rgba(0,0,0,0.55)]",
    tape: "bg-slate-300/92 shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-slate-400/80",
    swatch:
      "border-slate-600/28 bg-[#e8f0f5] dark:border-slate-300/40 dark:bg-slate-700/82",
    field:
      "border-slate-700/40 bg-white/90 text-slate-900 placeholder:text-slate-600/75 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] focus-visible:border-slate-600 focus-visible:ring-[3px] focus-visible:ring-slate-500/30 dark:border-slate-200/30 dark:bg-black/38 dark:text-slate-50 dark:placeholder:text-slate-200/60 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)] dark:focus-visible:border-slate-200 dark:focus-visible:ring-slate-400/38",
    dialogTint:
      "bg-linear-to-b from-slate-500/[0.04] via-transparent to-transparent dark:from-slate-400/[0.05]",
  },
];

function paletteIndex(raw: number) {
  return ((raw % COLOR_COUNT) + COLOR_COUNT) % COLOR_COUNT;
}

function noteApiBase(owner: string, repo: string) {
  return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/notes`;
}

function noteTiltClass(i: number) {
  const r = i % 3;
  if (r === 0) return "-rotate-[1.25deg]";
  if (r === 1) return "rotate-[0.85deg]";
  return "rotate-0";
}

/** Which tear pattern to use when a note is removed (stable per note id). */
function tearVariantFromNoteId(noteId: string): 0 | 1 | 2 | 3 {
  let h = 0;
  for (let i = 0; i < noteId.length; i++) {
    h = (h + noteId.charCodeAt(i) * (i + 1)) % 10007;
  }
  return (h % 4) as 0 | 1 | 2 | 3;
}

type StickyPaletteEntry = (typeof STICKY_PALETTE)[number];

function StickyGridNoteFace(props: {
  note: NoteRow;
  skin: StickyPaletteEntry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { note: n, skin, onEdit, onDelete } = props;
  return (
    <>
      <div
        className={cn(
          "absolute top-1.5 left-1/2 z-10 h-2.5 w-9 -translate-x-1/2 rounded-[1px] opacity-95",
          skin.tape,
        )}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-[3px] ring-1 ring-inset ring-white/25 dark:ring-white/10"
        aria-hidden
      />
      <div className="flex min-h-0 flex-1 flex-col gap-1">
        {n.title.trim() ? (
          <p className="m-0 line-clamp-1 font-semibold text-[12px] leading-tight tracking-tight">
            {n.title}
          </p>
        ) : null}
        <p
          className="m-0 min-h-0 flex-1 overflow-hidden text-[11.5px] leading-snug opacity-[0.93] line-clamp-7"
          title={n.body}
        >
          {n.body}
        </p>
      </div>
      <div className="mt-2 flex shrink-0 justify-end gap-0.5 border-black/8 border-t pt-1.5 dark:border-white/14">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-current opacity-80 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/15"
          aria-label="Edit note"
          onClick={onEdit}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-current opacity-80 hover:bg-destructive/15 hover:text-destructive dark:hover:bg-destructive/20"
          aria-label="Delete note"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </>
  );
}

export function RepoNotesTab(props: RepoNotesTabProps) {
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftColor, setDraftColor] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<NoteRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [tearingId, setTearingId] = useState<string | null>(null);
  const tearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const api = useMemo(
    () => noteApiBase(props.routeOwner, props.routeRepo),
    [props.routeOwner, props.routeRepo],
  );

  const draftSkin =
    STICKY_PALETTE[paletteIndex(draftColor)] ?? STICKY_PALETTE[0]!;

  const [deleteDialogSkin, setDeleteDialogSkin] = useState(
    () => STICKY_PALETTE[0]!,
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const res = await fetch(api);
        const body = (await res.json().catch(() => ({}))) as {
          notes?: NoteRow[];
          error?: string;
        };
        if (!res.ok) {
          throw new Error(body.error ?? res.statusText);
        }
        if (!cancelled) {
          setNotes(Array.isArray(body.notes) ? body.notes : []);
        }
      } catch (e) {
        if (!cancelled) {
          toast.error(
            e instanceof Error ? e.message : "Could not load notes",
          );
          setNotes([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(
    () => () => {
      if (tearTimeoutRef.current) clearTimeout(tearTimeoutRef.current);
    },
    [],
  );

  const openNew = () => {
    setEditingId(null);
    setDraftTitle("");
    setDraftBody("");
    setDraftColor(Math.floor(Math.random() * STICKY_PALETTE.length));
    setDialogOpen(true);
  };

  const openEdit = (n: NoteRow) => {
    setEditingId(n.id);
    setDraftTitle(n.title);
    setDraftBody(n.body);
    setDraftColor(
      paletteIndex(typeof n.color_index === "number" ? n.color_index : 0),
    );
    setDialogOpen(true);
  };

  const saveNote = async () => {
    const body = draftBody.trim();
    if (!body) {
      toast.error("Write something on the note.");
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        const res = await fetch(`${api}/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: draftTitle.trim().slice(0, NOTE_TITLE_MAX),
            body: body.slice(0, NOTE_BODY_MAX),
            color_index: paletteIndex(draftColor),
          }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          note?: NoteRow;
          error?: string;
        };
        if (!res.ok) throw new Error(json.error ?? res.statusText);
        if (json.note) {
          setNotes((prev) =>
            prev.map((n) => (n.id === json.note!.id ? json.note! : n)),
          );
        }
        toast.success("Note updated");
      } else {
        const res = await fetch(api, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: draftTitle.trim().slice(0, NOTE_TITLE_MAX),
            body: body.slice(0, NOTE_BODY_MAX),
            color_index: paletteIndex(draftColor),
          }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          note?: NoteRow;
          error?: string;
        };
        if (!res.ok) throw new Error(json.error ?? res.statusText);
        if (json.note) {
          setNotes((prev) => [json.note!, ...prev]);
        }
        toast.success("Note added");
      }
      setDialogOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleting(true);
    try {
      const res = await fetch(`${api}/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      setDeleteTarget(null);
      setTearingId(id);
      toast.success("Note torn off");
      if (tearTimeoutRef.current) clearTimeout(tearTimeoutRef.current);
      tearTimeoutRef.current = setTimeout(() => {
        tearTimeoutRef.current = null;
        setNotes((prev) => prev.filter((n) => n.id !== id));
        setTearingId(null);
      }, NOTE_TEAR_OFF_MS);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center justify-between gap-3 border-border/50 border-b px-4 py-3 md:px-6">
        <p className="m-0 text-[12px] text-muted-foreground leading-snug">
          Short sticky notes for this repo ({NOTE_BODY_MAX} characters max).
        </p>
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1.5 shrink-0"
          onClick={openNew}
        >
          <Plus className="size-3.5" aria-hidden />
          New note
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loading ? (
          <p className="px-4 py-8 text-[13px] text-muted-foreground md:px-6">
            Loading notes…
          </p>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center md:px-6">
            <StickyNote
              className="size-10 text-muted-foreground/50"
              aria-hidden
            />
            <p className="m-0 max-w-sm text-[13px] text-muted-foreground leading-relaxed">
              No notes yet. Add a quick reminder, idea, or follow-up—like paper
              sticky notes on your monitor.
            </p>
            <Button type="button" size="sm" onClick={openNew}>
              Add your first note
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 md:p-6 lg:grid-cols-5 xl:grid-cols-6">
            {notes.map((n, i) => {
              const ci = paletteIndex(
                typeof n.color_index === "number" ? n.color_index : 0,
              );
              const skin = STICKY_PALETTE[ci] ?? STICKY_PALETTE[0]!;
              const tilt = noteTiltClass(i);
              const isRipping = deleteTarget?.id === n.id;
              const isTearingAway = tearingId === n.id;

              const renderFace = () => (
                <StickyGridNoteFace
                  note={n}
                  skin={skin}
                  onEdit={() => openEdit(n)}
                  onDelete={() => {
                    setDeleteDialogSkin(skin);
                    setDeleteTarget(n);
                  }}
                />
              );

              if (isTearingAway) {
                const tearV = tearVariantFromNoteId(n.id);
                const tearRot =
                  tearV === 2
                    ? "scale-[1.16] rotate-[36deg]"
                    : tearV === 3
                      ? "scale-[1.16] -rotate-[41deg]"
                      : "";
                const fragA =
                  tearV === 1
                    ? "sticky-tear-frag-v-left"
                    : "sticky-tear-frag-h-top";
                const fragB =
                  tearV === 1
                    ? "sticky-tear-frag-v-right"
                    : "sticky-tear-frag-h-bottom";

                return (
                  <div
                    key={n.id}
                    className="relative z-30 h-44 w-full min-w-0 overflow-visible pointer-events-none"
                  >
                    <div className="absolute inset-0 rounded-[3px]">
                      <div
                        className={cn(
                          "absolute inset-0 origin-center",
                          tilt,
                          tearV >= 2 && tearRot,
                        )}
                      >
                        <div className="relative h-full w-full">
                          <div
                            className={cn(
                              "absolute inset-0 overflow-hidden",
                              skin.card,
                              fragA,
                            )}
                          >
                            <div className="relative flex h-full min-h-0 flex-col p-3 pt-5">
                              {renderFace()}
                            </div>
                          </div>
                          <div
                            className={cn(
                              "absolute inset-0 overflow-hidden",
                              skin.card,
                              fragB,
                            )}
                          >
                            <div className="relative flex h-full min-h-0 flex-col p-3 pt-5">
                              {renderFace()}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={n.id}
                  className={cn(
                    "group relative flex h-44 w-full min-w-0 flex-col rounded-[3px] transition-[transform,box-shadow] duration-200 hover:z-1 hover:scale-[1.03] hover:shadow-[3px_5px_0_rgba(0,0,0,0.08),8px_20px_36px_rgba(0,0,0,0.16)] dark:hover:shadow-[3px_5px_0_rgba(0,0,0,0.35),8px_20px_40px_rgba(0,0,0,0.5)]",
                    skin.card,
                    tilt,
                  )}
                >
                  <div
                    className={cn(
                      "relative flex min-h-0 flex-1 flex-col p-3 pt-5",
                      isRipping && "sticky-note-rip-inner",
                    )}
                  >
                    {renderFace()}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="gap-0 overflow-hidden border-0 bg-transparent p-0 shadow-none ring-0 sm:max-w-md">
          <div
            className={cn(
              "relative w-full max-w-full overflow-hidden rounded-xl border border-border bg-background text-foreground text-[13px] shadow-xl ring-1 ring-foreground/10",
            )}
          >
            <div
              className={cn(
                "pointer-events-none absolute inset-0 rounded-[inherit] opacity-95",
                draftSkin.dialogTint,
              )}
              aria-hidden
            />
            <div className="relative z-10 flex max-h-[min(90vh,46rem)] min-h-0 flex-col">
              <div className="px-5 pt-7 pb-3">
                <DialogHeader className="gap-1 text-left">
                  <DialogTitle>
                    {editingId ? "Edit note" : "New sticky note"}
                  </DialogTitle>
                  <DialogDescription>
                    Subtle tint follows the swatch below (not the whole sheet).{" "}
                    {NOTE_BODY_MAX} characters max.
                  </DialogDescription>
                </DialogHeader>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="note-title"
                      className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide"
                    >
                      Title{" "}
                      <span className="font-normal lowercase text-muted-foreground/80">
                        (optional)
                      </span>
                    </label>
                    <input
                      id="note-title"
                      value={draftTitle}
                      onChange={(e) =>
                        setDraftTitle(e.target.value.slice(0, NOTE_TITLE_MAX))
                      }
                      placeholder="e.g. Ship checklist"
                      maxLength={NOTE_TITLE_MAX}
                      className="border-input bg-background rounded-md border px-3 py-2 text-[13px] text-foreground outline-none ring-0 transition-shadow placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="note-body"
                      className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide"
                    >
                      Note
                    </label>
                    <textarea
                      id="note-body"
                      value={draftBody}
                      onChange={(e) =>
                        setDraftBody(e.target.value.slice(0, NOTE_BODY_MAX))
                      }
                      placeholder="Write something…"
                      rows={5}
                      maxLength={NOTE_BODY_MAX}
                      className="border-input min-h-[120px] resize-y rounded-md border bg-background px-3 py-2 text-[13px] leading-snug text-foreground outline-none transition-shadow placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                    <p className="text-right text-[11px] text-muted-foreground tabular-nums">
                      {draftBody.length}/{NOTE_BODY_MAX}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                      Color
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {STICKY_PALETTE.map((p, idx) => (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => setDraftColor(idx)}
                          className={cn(
                            "size-9 rounded-md border-2 shadow-sm transition-[transform,box-shadow,ring]",
                            p.swatch,
                            draftColor === idx
                              ? "scale-95 shadow-md ring-2 ring-foreground ring-offset-0"
                              : "opacity-90 hover:scale-105 hover:opacity-100",
                          )}
                          aria-label={`Sticky color ${idx + 1}`}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <DialogFooter className="relative z-10 mx-0 mb-0 gap-2 border-border border-t bg-muted/35 px-5 pt-4 pb-6 sm:flex-row sm:justify-end sm:gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => void saveNote()}
                  disabled={saving}
                >
                  {saving ? "Saving…" : editingId ? "Save" : "Add note"}
                </Button>
              </DialogFooter>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent className="!w-full gap-0 overflow-visible border-0 bg-transparent p-0 shadow-none ring-0 !max-w-[min(100%,32rem)] sm:!max-w-[32rem]">
          <div className="sticky-delete-dialog-enter !w-full overflow-visible pb-4 !max-w-[min(100%,32rem)] sm:!max-w-[32rem]">
            <div
              className={cn(
                "relative flex flex-col overflow-hidden rounded-[4px] text-[13px] shadow-2xl ring-2 ring-black/18",
                "drop-shadow-[0_14px_36px_rgba(0,0,0,0.55)] dark:ring-white/22",
                "dark:drop-shadow-[0_16px_40px_rgba(0,0,0,0.85)]",
              )}
            >
              <div className={cn("relative rounded-t-[4px]", deleteDialogSkin.card)}>
                <div
                  className={cn(
                    "absolute top-1.5 left-1/2 z-10 h-2.5 w-10 -translate-x-1/2 rounded-[1px]",
                    deleteDialogSkin.tape,
                  )}
                  aria-hidden
                />
                <div
                  className="pointer-events-none absolute inset-0 z-0 rounded-t-[4px] ring-1 ring-inset ring-white/35 dark:ring-white/12"
                  aria-hidden
                />
                <div className="relative z-20 px-5 pt-8 pb-3">
                  <AlertDialogHeader className="text-left sm:text-left">
                    <div className="mb-1 flex items-center gap-2 text-destructive">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-destructive/16 ring-1 ring-destructive/30">
                        <AlertTriangle className="size-4" aria-hidden />
                      </span>
                      <AlertDialogTitle className="text-destructive">
                        Tear this note off?
                      </AlertDialogTitle>
                    </div>
                    <AlertDialogDescription className="text-current/80">
                      This rips the sticky away for good—there is no undo.
                      {deleteTarget?.title.trim() ? (
                        <span className="mt-2 block font-medium text-current">
                          “{deleteTarget.title.trim()}”
                        </span>
                      ) : null}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                </div>
                <div
                  className="relative z-20 w-full min-w-0 border-destructive/55 border-t border-dotted"
                  aria-hidden
                />
              </div>
              <div
                className={cn(
                  "sticky-torn-strip relative z-10 min-w-0 self-stretch",
                  deleteDialogSkin.card,
                )}
                aria-hidden
              />
              <AlertDialogFooter className="relative z-0 -mt-[52px] gap-2 rounded-b-[4px] border-border border-t bg-background px-5 pt-14 pb-6 sm:flex-row sm:justify-end sm:gap-2">
                <AlertDialogCancel disabled={deleting}>
                  Keep it
                </AlertDialogCancel>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={deleting}
                  onClick={() => void confirmDelete()}
                >
                  {deleting ? "Tearing…" : "Tear off"}
                </Button>
              </AlertDialogFooter>
            </div>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
