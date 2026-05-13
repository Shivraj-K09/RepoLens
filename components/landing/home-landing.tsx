import { LandingShell, type LandingAuthorLinks } from "@/components/landing/landing-shell";
import { LandingRepoInput } from "@/components/landing/landing-repo-input";
import type { LandingAuthSnapshot } from "@/lib/auth/landing-auth";

type HomeLandingProps = {
  auth: LandingAuthSnapshot | null;
};

function authorLinks(): LandingAuthorLinks {
  return {
    github: process.env.NEXT_PUBLIC_AUTHOR_GITHUB_URL?.trim() ?? "",
    linkedIn: process.env.NEXT_PUBLIC_AUTHOR_LINKEDIN_URL?.trim() ?? "",
  };
}

export function HomeLanding({ auth }: HomeLandingProps) {
  const author = authorLinks();

  return (
    <LandingShell auth={auth} author={author}>
      <section
        aria-labelledby="hero-heading"
        className="w-full max-w-2xl text-center"
      >
        <h1
          id="hero-heading"
          className="text-pretty text-[1.5rem] font-semibold leading-tight tracking-[-0.035em] text-foreground sm:text-[1.75rem] md:text-[1.875rem]"
        >
          Understand any GitHub repository in minutes.
        </h1>
      </section>

      <div className="w-full max-w-2xl">
        <LandingRepoInput />
      </div>
    </LandingShell>
  );
}
