/** Shell while repo detail data streams in (heavy GitHub fetches). */
export default function RepoDetailLoading() {
  return (
    <div className="space-y-4 px-6 py-6 md:px-10 md:py-8">
      <div className="flex animate-pulse items-start gap-3">
        <div className="size-9 shrink-0 rounded-md bg-muted" />
        <div className="min-w-0 flex-1 space-y-2 py-px">
          <div className="h-5 max-w-[14rem] rounded bg-muted/80" />
          <div className="h-4 max-w-[10rem] rounded bg-muted/60" />
        </div>
      </div>
      <div className="h-52 max-w-xl animate-pulse rounded-lg border border-border/40 bg-muted/25 md:h-56" />
    </div>
  );
}
