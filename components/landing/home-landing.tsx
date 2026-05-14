import { LandingRepoInput } from "@/components/landing/landing-repo-input";

/** Home route body only — sidebar + shell come from `app/(www)/layout.tsx`. */
export function HomePageContent() {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center px-5 py-10 md:px-8 md:py-14">
      <div className="-translate-y-5 mx-auto flex w-full max-w-3xl flex-col items-center gap-3 md:-translate-y-8 md:gap-4">
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
      </div>
    </div>
  );
}
