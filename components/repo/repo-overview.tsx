import { Cpu, Layers } from "lucide-react";

import type { RepoTechStackSummary } from "@/lib/github/repo-tech-stack";

import { cn } from "@/lib/utils";

export function RepoOverviewContent({
  displayOwner,
  displayRepo,
  description,
  defaultBranch,
  shaShort,
  htmlUrl,
  starsText,
  forksText,
  metadataPartialNote,
  techStack,
}: {
  displayOwner: string;
  displayRepo: string;
  description: string | null;
  defaultBranch: string | null;
  shaShort: string | null | undefined;
  htmlUrl: string | null;
  starsText: string;
  forksText: string;
  metadataPartialNote: boolean;
  techStack: RepoTechStackSummary | null;
}) {
  const hasDeps =
    (techStack?.npmProductionDeps?.length ?? 0) +
      (techStack?.npmDevDeps?.length ?? 0) >
    0;
  const hasEco =
    Array.isArray(techStack?.ecosystems) && techStack.ecosystems.length > 0;

  return (
    <div className="space-y-6 px-6 py-5 md:space-y-7 md:px-8 lg:pb-8 lg:pt-6">
      <section className="rounded-lg border border-border/55 bg-muted/[0.06] px-4 py-3.25 md:px-5">
        <h2 className="mb-1.75 font-medium text-[12.75px] text-foreground tracking-tight">
          About
        </h2>
        {description ? (
          <p className="max-w-3xl text-[12.85px] text-muted-foreground leading-relaxed tracking-tight">
            {description}
          </p>
        ) : (
          <p className="italic text-muted-foreground text-[12.85px]">
            No description on GitHub.
          </p>
        )}
        <dl className="mt-3.5 grid gap-2 border-border/50 border-t pt-3 font-mono text-[11px] text-muted-foreground sm:grid-cols-2">
          <div>
            <dt className="sr-only">Default branch</dt>
            <dd>
              Branch{" "}
              <span className="text-foreground/90">{defaultBranch ?? "-"}</span>
            </dd>
          </div>
          <div>
            <dt className="sr-only">HEAD commit</dt>
            <dd>
              HEAD{" "}
              <span className="break-all text-foreground/85">{shaShort ?? "-"}</span>
            </dd>
          </div>
          <div>
            <dt className="sr-only">Stars</dt>
            <dd>
              Stars <span className="tabular-nums text-foreground">{starsText}</span>
            </dd>
          </div>
          <div>
            <dt className="sr-only">Forks</dt>
            <dd>
              Forks <span className="tabular-nums text-foreground">{forksText}</span>
            </dd>
          </div>
        </dl>
      </section>

      {metadataPartialNote ? (
        <p className="max-w-2xl text-amber-800/92 text-[11.75px] leading-relaxed dark:text-amber-200/82">
          Some GitHub fields may be stale or missing until{" "}
          <span className="font-mono">GITHUB_TOKEN</span> is set on the server.
        </p>
      ) : null}

      {!htmlUrl ? (
        <p className="text-muted-foreground text-[11.75px]">No canonical GitHub URL.</p>
      ) : (
        <a
          href={htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex text-muted-foreground text-[12px] underline decoration-border underline-offset-[3px] hover:text-foreground"
        >
          Open {displayOwner}/{displayRepo} on GitHub
        </a>
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2 font-medium text-[12.75px] text-foreground tracking-tight">
          <Layers aria-hidden strokeWidth={1.7} className="size-4 text-muted-foreground" />
          Tech stack
        </div>
        {techStack == null ? (
          <p className="max-w-xl text-muted-foreground text-[12px] leading-relaxed">
            Default branch unavailable: reload after metadata resolves, or set{" "}
            <span className="font-mono text-foreground/90">GITHUB_TOKEN</span>.
          </p>
        ) : (
          <>
            {hasEco ? (
              <ul className="mb-4 flex flex-wrap gap-2">
                {techStack.ecosystems.map((label) => (
                  <li
                    key={label}
                    className="rounded-full border border-border/60 bg-background px-2.75 py-1 font-medium text-[11.25px] text-foreground"
                  >
                    {label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-4 text-muted-foreground text-[12px] italic">
                No recognized manifest at repo root yet (markers like{" "}
                <span className="font-mono text-foreground/85">Cargo.toml</span>,{" "}
                <span className="font-mono text-foreground/85">go.mod</span>,{" "}
                <span className="font-mono text-foreground/85">pyproject.toml</span>
                ).
              </p>
            )}

            {techStack.npmParseFailed && !hasDeps ? (
              <p className="flex items-start gap-2 text-muted-foreground text-[12px]">
                <Cpu
                  aria-hidden
                  strokeWidth={1.65}
                  className="mt-0.25 size-3.5 shrink-0"
                />
                <span className="leading-snug">
                  Found <span className="font-mono">package.json</span> but could
                  not read dependency lists (syntax, visibility, or size limits).
                </span>
              </p>
            ) : null}

            {hasDeps ? (
              <div className="space-y-4">
                {techStack.npmProductionDeps.length > 0 ? (
                  <div>
                    <h3 className="mb-1.75 font-mono font-medium text-[10.85px] text-muted-foreground uppercase tracking-wider">
                      npm dependencies (top {techStack.npmProductionDeps.length})
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {techStack.npmProductionDeps.map((pkg) => (
                        <Chip key={pkg} variant="accent">
                          {pkg}
                        </Chip>
                      ))}
                    </div>
                  </div>
                ) : null}
                {techStack.npmDevDeps.length > 0 ? (
                  <div>
                    <h3 className="mb-1.75 font-mono font-medium text-[10.85px] text-muted-foreground uppercase tracking-wider">
                      devDependencies (top {techStack.npmDevDeps.length})
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {techStack.npmDevDeps.map((pkg) => (
                        <Chip key={`dev-${pkg}`}>{pkg}</Chip>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : techStack.ecosystems.includes("Node.js") ? (
              <p className="text-muted-foreground text-[12px]">
                No npm dependency sections in manifest (workspace package or minimal
                <span className="font-mono"> package.json</span>).
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

function Chip({
  children,
  variant = "muted",
}: {
  children: string;
  variant?: "muted" | "accent";
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full truncate rounded-md border px-1.75 py-0.65 font-mono text-[10.75px]",
        variant === "accent"
          ? "border-border/55 bg-muted/46 text-foreground"
          : "border-border/40 bg-muted/[0.2] text-muted-foreground",
      )}
      title={children}
    >
      {children}
    </span>
  );
}
