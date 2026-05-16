# RepoLens

**Understand GitHub repositories easily with AI.**

RepoLens is a full-stack Next.js app that turns a noisy GitHub repo into a clear overview: metadata and README, a fast file explorer, optional **RAG** (retrieval-augmented generation) chat grounded in the codebase, and visit history for signed-in users.

It is intentionally **not** a GitHub clone—it is a **developer tool** for faster repo comprehension.

---

## Features

- **GitHub sign-in** via Supabase Auth (OAuth with GitHub).
- **Add a repository** by pasting a GitHub URL; metadata, README, and tech-stack hints are loaded server-side.
- **Repository page** with tabs for overview, code explorer (virtualized tree, multi-file tabs, caching), and README.
- **AI chat (RAG)** in a side rail: index embeddings for a repo, then ask questions with streaming responses; chats persist per user and repo.
- **Recent repositories** (“history”) in the landing sidebar.
- **Security-minded defaults**: protected routes, Zod validation on API routes, rate limiting on sensitive paths, sanitized Markdown/HTML for README-style content.

---

## Tech stack

| Area        | Choices                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Framework   | [Next.js](https://nextjs.org/) 16 (App Router), React 19, TypeScript                           |
| Styling     | Tailwind CSS v4, [shadcn/ui](https://ui.shadcn.com/)-style components                          |
| Data / auth | [Supabase](https://supabase.com/) (PostgreSQL, `pgvector`, Row Level Security, SSR helpers)    |
| GitHub API  | [Octokit](https://github.com/octokit/rest.js) (optional `GITHUB_TOKEN` for higher rate limits) |
| AI          | [Vercel AI SDK](https://sdk.vercel.ai/) + Hugging Face Inference (chat + embeddings)           |

**Note:** The app uses **Supabase** for PostgreSQL, auth, and RLS—**not** Prisma or Auth.js.

---

## Prerequisites

- **Node.js** (LTS recommended)
- **pnpm** (lockfile: `pnpm-lock.yaml`)
- A **Supabase** project with GitHub OAuth configured and the schema your deployment needs (tables, RLS, and any vector search setup for embeddings).
- **Hugging Face** API key for chat and embeddings (see `.env.example`).

---

## Local development

```bash
pnpm install
cp .env.example .env
# Fill in Supabase URL/keys, Hugging Face key, NEXT_PUBLIC_SITE_URL, etc.

pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

Other scripts:

```bash
pnpm build   # production build
pnpm start   # run production server
pnpm lint    # ESLint
```

---

## Environment variables

Copy [`.env.example`](./.env.example) to `.env` and set:

- **Site URL** — `NEXT_PUBLIC_SITE_URL` (must match Supabase Auth redirect allowlist).
- **Supabase** — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`; server-only `SUPABASE_SERVICE_ROLE` when required for privileged jobs.
- **GitHub** — optional `GITHUB_TOKEN` for richer API quotas.
- **Hugging Face** — `HUGGINGFACE_API_KEY`, optional `HUGGINGFACE_CHAT_MODEL` / `HUGGINGFACE_EMBEDDING_MODEL`.
- **Footer** (assignment) — `NEXT_PUBLIC_AUTHOR_NAME`, `NEXT_PUBLIC_AUTHOR_GITHUB_URL`, `NEXT_PUBLIC_AUTHOR_LINKEDIN_URL`.

Never commit `.env` or real secrets.

---

## Project layout (high level)

- `app/` — routes, layouts, API route handlers (`app/api/...`).
- `components/` — UI, including repo detail, explorer, and AI chat rail.
- `lib/` — GitHub helpers, AI/RAG, Supabase clients, formatting utilities.

---

## License

No license file is included in this repository. Add one if you publish or redistribute the code.
