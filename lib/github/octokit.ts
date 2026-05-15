import { Octokit } from "@octokit/rest";

const USER_AGENT = "house-assignment/0.1.0 (RepoLens; Next.js server)";

export function createOctokit(): Octokit {
  const token = process.env.GITHUB_TOKEN?.trim();

  return new Octokit({
    userAgent: USER_AGENT,
    request: {
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
    ...(token ? { auth: token } : {}),
  });
}
