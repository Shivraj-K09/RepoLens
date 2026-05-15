import { generateText, streamText } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getHuggingFaceChatLanguageModel } from "@/lib/ai/huggingface-chat-model";
import {
  buildRagPrompt,
  DEFAULT_RAG_MATCH_COUNT,
  embedRagQueryText,
  matchRepositoryEmbeddings,
} from "@/lib/ai/rag-query";
import {
  deriveChatTitleFromQuestion,
  normalizeRagAnswer,
} from "@/lib/ai/rag/answer-normalization";
import {
  collectMissingCoverageHints,
  isCodebaseOverviewIntent,
  isFolderInventoryIntent,
  isLocationLookupIntent,
  isModelContextQuestion,
  isMultiPartQuestion,
  isProviderBadRequestError,
  isStructureDetailIntent,
  isSummaryIntent,
  isWorkflowGuidanceIntent,
  userExplicitlyAskedForExternalLinks,
  userExplicitlyAskedToIgnoreReadme,
} from "@/lib/ai/rag/intents";
import {
  extractKeywordHints,
  extractPathHints,
} from "@/lib/ai/rag/query-hints";
import {
  fetchCachedReadmeMarkdown,
  fetchCachedRepoTreePaths,
  withTimeoutOrFallback,
} from "@/lib/ai/rag/cache";
import {
  fetchChatHistoryBlockForRag,
  persistChatTurn,
} from "@/lib/ai/rag/chat-history";
import {
  buildCachedRepositoryAiSummaryContext,
  buildCommitDetailsContextForQuestion,
  buildDirectPathContext,
  buildGitHubFactsContextForQuestion,
  buildInferredKeywordContext,
  buildIssuePullDirectAnswerForQuestion,
  buildMentionedPathKindContext,
  buildQuestionEvidenceContext,
  buildRecentCommitsContextLines,
  buildRepositoryMetadataContext,
  buildRepositorySignalContext,
  buildRepositoryTreeContext,
  buildWorkflowDocsContext,
  type RepositoryMetadataSnapshot,
} from "@/lib/ai/rag/repository-context";
import {
  buildAuthoritativeLocationContext,
  buildKeywordLocationCandidateContext,
  fetchHintPathChunks,
  fetchKeywordPathChunks,
  inferLikelyPathsFromTree,
} from "@/lib/ai/rag/retrieval";
import { type RepoTreePaths } from "@/lib/github/repo-tree";
import {
  checkRateLimit,
  rateLimitExceededResponse,
} from "@/lib/security/rate-limit";
import { sanitizeErrorMessage } from "@/lib/security/sanitize-error-message";
import { createClient } from "@/lib/supabase/server";
import { getSavedRepositoryForIndexing } from "@/lib/supabase/require-repo-for-user";

const bodySchema = z.object({
  question: z.string().trim().min(1, "Question is required").max(8_000),
  /** When true, response is `text/plain` streamed with `streamText`. */
  stream: z.boolean().optional(),
  /** Browser IANA timezone for resolving relative dates like "today". */
  timezone: z.string().trim().min(1).max(64).optional(),
  /** Override default number of chunks (max 32 in SQL). */
  match_count: z.number().int().min(1).max(32).optional(),
  /** Optional persisted chat id for history. */
  chat_id: z.string().uuid().optional(),
});

type RouteParams = { params: Promise<{ owner: string; repo: string }> };

const SEMANTIC_SEARCH_TIMEOUT_MS = 3000;
const CONTEXT_ENRICHMENT_TIMEOUT_MS = 1800;

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function buildRequestDateContext(timeZoneInput: string | undefined): string {
  const now = new Date();
  const timeZone =
    timeZoneInput && isValidTimeZone(timeZoneInput) ? timeZoneInput : "UTC";
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  return [
    "Request date context:",
    `- current instant (UTC): ${now.toISOString()}`,
    `- user timezone: ${timeZone}`,
    `- local today: ${formatDateInTimeZone(now, timeZone)}`,
    `- local yesterday: ${formatDateInTimeZone(yesterday, timeZone)}`,
    `- local tomorrow: ${formatDateInTimeZone(tomorrow, timeZone)}`,
    '- Interpret "today", "yesterday", and similar relative date words as local calendar dates in this timezone unless the user specifies otherwise.',
    '- Do not treat "yesterday" as "the last 24 hours"; use "last 24 hours" only when the user asks for a rolling 24-hour window.',
    "- GitHub commit timestamps are UTC ISO strings; convert them to the user timezone before counting commits by local date.",
  ].join("\n");
}

function isFollowUpQuestion(question: string): boolean {
  return /\b(that|it|those|them|previous|above|same|again|that commit|that file|that folder)\b/i.test(
    question,
  );
}

function isGithubFactsQuestion(question: string): boolean {
  return /\b(github|octokit|issues?|pull requests?|prs?|merge requests?|branches?|tags?|releases?|contributors?|contributed|stars?|forks?|watchers?|license|visibility|created|updated|pushed|default branch|languages?|topics?|workflows?|actions|commits?)\b/i.test(
    question,
  );
}

export async function POST(request: Request, { params }: RouteParams) {
  const { owner: ownerParam, repo: repoParam } = await params;
  const ownerNorm = ownerParam.toLowerCase();
  const repoNorm = repoParam.toLowerCase();

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ragRateLimit = checkRateLimit({
    request,
    namespace: "repos:rag",
    userId: user.id,
    max: 45,
    windowMs: 60 * 1000,
  });
  if (!ragRateLimit.allowed) {
    return rateLimitExceededResponse(
      ragRateLimit,
      "Too many AI requests. Please wait a moment and try again.",
    );
  }

  const repoRow = await getSavedRepositoryForIndexing(
    user.id,
    ownerNorm,
    repoNorm,
  );
  if (!repoRow) {
    return NextResponse.json(
      { error: "Repository not saved for this account" },
      { status: 403 },
    );
  }

  const indexedSha = repoRow.indexed_commit_sha?.trim();
  if (!indexedSha) {
    return NextResponse.json(
      {
        error:
          "This repository is not indexed yet. Call POST .../index-embeddings first.",
      },
      { status: 422 },
    );
  }

  if (!process.env.HUGGINGFACE_API_KEY?.trim()) {
    return NextResponse.json(
      { error: "Server is missing HUGGINGFACE_API_KEY." },
      { status: 503 },
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const {
    question,
    stream: streamRequested,
    timezone,
    match_count,
    chat_id,
  } = parsed.data;
  const requestDateContext = buildRequestDateContext(timezone);
  const summaryIntent = isSummaryIntent(question);
  const pathHints = extractPathHints(question);
  const keywordHints = extractKeywordHints(question);
  const folderInventoryIntent = isFolderInventoryIntent(question);
  const codebaseOverviewIntent = isCodebaseOverviewIntent(question);
  const structureDetailIntent = isStructureDetailIntent(question);
  const locationLookupIntent = isLocationLookupIntent(question);
  const workflowGuidanceIntent = isWorkflowGuidanceIntent(question);
  const modelContextQuestion = isModelContextQuestion(question);
  const followUpQuestion = isFollowUpQuestion(question);
  const githubFactsQuestion = isGithubFactsQuestion(question);
  const commitActivityQuestion =
    /\b(commits?|committers?|activity|recent changes?|latest changes?|history|today|yesterday|last 24 hours|20\d{2}-\d{2}-\d{2})\b/i.test(
      question,
    );
  const allowExternalLinks = userExplicitlyAskedForExternalLinks(question);
  const ignoreReadmeContext = userExplicitlyAskedToIgnoreReadme(question);
  const { data: repositoryMetadataRow } = await supabase
    .from("repositories")
    .select(
      "github_owner, github_repo, description, default_branch, stars_count, forks_count, last_commit_sha, html_url",
    )
    .eq("id", repoRow.id)
    .maybeSingle();
  const repositoryMetadataContext = buildRepositoryMetadataContext(
    (repositoryMetadataRow as RepositoryMetadataSnapshot | null) ?? null,
  );

  let persistedChatId: string | null = null;
  if (chat_id) {
    const { data: chatRow, error: chatError } = await supabase
      .from("chats")
      .select("id")
      .eq("id", chat_id)
      .eq("user_id", user.id)
      .eq("repository_id", repoRow.id)
      .maybeSingle();
    if (chatError) {
      return NextResponse.json(
        { error: sanitizeErrorMessage(chatError.message) },
        { status: 500 },
      );
    }
    if (!chatRow) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }
    persistedChatId = chatRow.id;
  } else {
    const { data: createdChat, error: createChatError } = await supabase
      .from("chats")
      .insert({
        user_id: user.id,
        repository_id: repoRow.id,
        title: deriveChatTitleFromQuestion(question),
      })
      .select("id")
      .single();
    if (createChatError || !createdChat?.id) {
      return NextResponse.json(
        {
          error: sanitizeErrorMessage(
            createChatError?.message ?? "Failed to create chat",
          ),
        },
        { status: 500 },
      );
    }
    persistedChatId = createdChat.id;
  }

  try {
    const getRepoTree = (() => {
      let treePromise: Promise<RepoTreePaths | null> | null = null;
      return () => {
        if (!treePromise) {
          treePromise = fetchCachedRepoTreePaths({
            owner: repoRow.github_owner,
            repo: repoRow.github_repo,
            commitSha: indexedSha,
          });
        }
        return treePromise;
      };
    })();

    const shouldIncludeReadme = summaryIntent && !ignoreReadmeContext;
    const readmeTextPromise = shouldIncludeReadme
      ? fetchCachedReadmeMarkdown({
          owner: repoRow.github_owner,
          repo: repoRow.github_repo,
          commitSha: indexedSha,
        })
      : Promise.resolve<string | null>(null);

    const shouldRunSemanticSearch = pathHints.length === 0;
    const semanticChunks = shouldRunSemanticSearch
      ? await withTimeoutOrFallback(
          (async () => {
            const queryEmbedding = await embedRagQueryText(question);
            return matchRepositoryEmbeddings(supabase, {
              repositoryId: repoRow.id,
              commitSha: indexedSha,
              queryEmbedding,
              matchCount:
                match_count ??
                (question.trim().length <= 48 ? 8 : DEFAULT_RAG_MATCH_COUNT),
            });
          })(),
          [],
          SEMANTIC_SEARCH_TIMEOUT_MS,
        )
      : [];

    const pathHintChunksPromise =
      pathHints.length > 0
        ? fetchHintPathChunks({
            supabase,
            repositoryId: repoRow.id,
            commitSha: indexedSha,
            hints: pathHints,
          })
        : Promise.resolve([]);
    const keywordPathChunksPromise =
      pathHints.length === 0 &&
      (locationLookupIntent || semanticChunks.length <= 4)
        ? fetchKeywordPathChunks({
            supabase,
            repositoryId: repoRow.id,
            commitSha: indexedSha,
            keywordHints,
          })
        : Promise.resolve([]);
    const [pathHintChunks, keywordPathChunks] = await Promise.all([
      pathHintChunksPromise,
      keywordPathChunksPromise,
    ]);

    const authoritativeLocationPathsPromise =
      locationLookupIntent &&
      pathHints.length === 0 &&
      semanticChunks.length <= 6
        ? inferLikelyPathsFromTree({
            owner: repoRow.github_owner,
            repo: repoRow.github_repo,
            commitSha: indexedSha,
            keywordHints,
            question,
          })
        : Promise.resolve<string[]>([]);
    const pathKindContextPromise =
      pathHints.length > 0
        ? buildMentionedPathKindContext({
            owner: repoRow.github_owner,
            repo: repoRow.github_repo,
            commitSha: indexedSha,
            hints: pathHints,
          })
        : Promise.resolve("");
    const directPathContextPromise = buildDirectPathContext({
      owner: repoRow.github_owner,
      repo: repoRow.github_repo,
      commitSha: indexedSha,
      hints: pathHints,
    });
    const shouldAttachRepoTree =
      (folderInventoryIntent && pathHints.length === 0) ||
      (codebaseOverviewIntent &&
        !summaryIntent &&
        structureDetailIntent &&
        pathHints.length === 0);
    const repoTreeContextPromise = shouldAttachRepoTree
      ? buildRepositoryTreeContext({
          owner: repoRow.github_owner,
          repo: repoRow.github_repo,
          commitSha: indexedSha,
          maxDepth: codebaseOverviewIntent ? 5 : 4,
          maxNodes: codebaseOverviewIntent ? 560 : 420,
        })
      : Promise.resolve("");
    const workflowDocsContextPromise = workflowGuidanceIntent
      ? buildWorkflowDocsContext({
          owner: repoRow.github_owner,
          repo: repoRow.github_repo,
          commitSha: indexedSha,
        })
      : Promise.resolve("");
    const repositorySignalContextPromise = buildRepositorySignalContext({
      owner: repoRow.github_owner,
      repo: repoRow.github_repo,
      commitSha: indexedSha,
    });
    const [
      authoritativeLocationPaths,
      pathKindContext,
      directPathContext,
      repoTreeContext,
      workflowDocsContext,
      repositorySignalContext,
    ] = await Promise.all([
      withTimeoutOrFallback(
        authoritativeLocationPathsPromise,
        [],
        CONTEXT_ENRICHMENT_TIMEOUT_MS,
      ),
      pathHints.length > 0
        ? pathKindContextPromise
        : withTimeoutOrFallback(
            pathKindContextPromise,
            "",
            CONTEXT_ENRICHMENT_TIMEOUT_MS,
          ),
      pathHints.length > 0
        ? directPathContextPromise
        : withTimeoutOrFallback(
            directPathContextPromise,
            "",
            CONTEXT_ENRICHMENT_TIMEOUT_MS,
          ),
      withTimeoutOrFallback(
        repoTreeContextPromise,
        "",
        CONTEXT_ENRICHMENT_TIMEOUT_MS,
      ),
      withTimeoutOrFallback(
        workflowDocsContextPromise,
        "",
        CONTEXT_ENRICHMENT_TIMEOUT_MS,
      ),
      withTimeoutOrFallback(
        repositorySignalContextPromise,
        "",
        CONTEXT_ENRICHMENT_TIMEOUT_MS,
      ),
    ]);
    const authoritativeLocationContext = buildAuthoritativeLocationContext(
      authoritativeLocationPaths,
    );
    const merged = [...pathHintChunks, ...keywordPathChunks, ...semanticChunks];
    const deduped = merged.filter((row, idx) => {
      return merged.findIndex((x) => x.id === row.id) === idx;
    });
    const chunks = deduped.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.chunk_index - b.chunk_index;
    });

    const keywordLocationContext =
      locationLookupIntent && pathHints.length === 0
        ? buildKeywordLocationCandidateContext({
            chunks,
            keywordHints,
            question,
          })
        : "";
    const inferredKeywordContext =
      chunks.length <= 4 && pathHints.length === 0
        ? await withTimeoutOrFallback(
            buildInferredKeywordContext({
              owner: repoRow.github_owner,
              repo: repoRow.github_repo,
              commitSha: indexedSha,
              keywordHints,
            }),
            "",
            CONTEXT_ENRICHMENT_TIMEOUT_MS,
          )
        : "";
    const readmeText = await readmeTextPromise;

    const [
      aiSummaryForRagContext,
      githubFactsForRagContext,
      recentCommitsForRagContext,
      commitDetailsForRagContext,
      priorChatContext,
    ] = await Promise.all([
      summaryIntent || codebaseOverviewIntent || modelContextQuestion
        ? buildCachedRepositoryAiSummaryContext(supabase, ownerNorm, repoNorm)
        : Promise.resolve(""),
      buildGitHubFactsContextForQuestion({
        owner: repoRow.github_owner,
        repo: repoRow.github_repo,
        defaultBranch:
          (repositoryMetadataRow as RepositoryMetadataSnapshot | null)
            ?.default_branch ?? null,
        question,
        timeZone: timezone,
      }),
      commitActivityQuestion
        ? buildRecentCommitsContextLines({
            owner: repoRow.github_owner,
            repo: repoRow.github_repo,
            defaultBranch:
              (repositoryMetadataRow as RepositoryMetadataSnapshot | null)
                ?.default_branch ?? null,
            question,
            timeZone: timezone,
          })
        : Promise.resolve(""),
      buildCommitDetailsContextForQuestion({
        owner: repoRow.github_owner,
        repo: repoRow.github_repo,
        defaultBranch:
          (repositoryMetadataRow as RepositoryMetadataSnapshot | null)
            ?.default_branch ?? null,
        question,
        timeZone: timezone,
      }),
      persistedChatId && (followUpQuestion || modelContextQuestion)
        ? fetchChatHistoryBlockForRag({
            supabase,
            chatId: persistedChatId,
          })
        : Promise.resolve(""),
    ]);
    const directIssuePullAnswer = await buildIssuePullDirectAnswerForQuestion({
      owner: repoRow.github_owner,
      repo: repoRow.github_repo,
      question,
    });
    if (directIssuePullAnswer) {
      try {
        await persistChatTurn({
          supabase,
          chatId: persistedChatId,
          userQuestion: question,
          assistantAnswer: directIssuePullAnswer,
        });
      } catch (persistError) {
        console.warn("[rag] chat persistence failed (direct facts):", persistError);
      }
      const headers = new Headers();
      headers.set("X-RepoLens-Commit-Sha", indexedSha);
      if (persistedChatId) {
        headers.set("X-RepoLens-Chat-Id", persistedChatId);
      }
      if (streamRequested === true) {
        headers.set("Content-Type", "text/plain; charset=utf-8");
        return new Response(directIssuePullAnswer, { status: 200, headers });
      }
      return NextResponse.json(
        {
          answer: directIssuePullAnswer,
          commit_sha: indexedSha,
          chat_id: persistedChatId,
          sources: [],
        },
        { headers },
      );
    }
    const questionEvidenceContext = await buildQuestionEvidenceContext({
      owner: repoRow.github_owner,
      repo: repoRow.github_repo,
      commitSha: indexedSha,
      question,
      keywordHints,
    });
    const modelContextManifest = modelContextQuestion
      ? [
          "Model context manifest for this request:",
          "- system instructions from buildRagPrompt",
          "- repository header: owner, repo, indexed commit SHA",
          `- semantic RAG chunks: ${chunks.length} matched chunk(s) from repository_embeddings`,
          readmeText
            ? "- README snapshot: included as secondary high-level context"
            : "- README snapshot: not included for this question",
          "- user question enriched with request date context",
          priorChatContext ? "- prior chat history for follow-up resolution" : "",
          repositoryMetadataContext
            ? "- saved repository metadata snapshot from Supabase repositories table"
            : "",
          aiSummaryForRagContext
            ? "- cached repository AI summary from repository_ai_summaries"
            : "",
          commitDetailsForRagContext
            ? "- focused GitHub commit detail from Octokit getCommit"
            : "",
          githubFactsForRagContext
            ? "- question-targeted live GitHub facts from Octokit"
            : "",
          questionEvidenceContext
            ? "- question-targeted repository evidence from manifests, indexed paths, and matching snippets"
            : "",
          recentCommitsForRagContext
            ? "- recent default-branch commits from Octokit listCommits"
            : "",
          pathKindContext ? "- resolved mentioned path kinds from indexed tree" : "",
          directPathContext ? "- direct file/folder content for mentioned paths" : "",
          authoritativeLocationContext
            ? "- authoritative location candidates inferred from indexed tree"
            : "",
          keywordLocationContext
            ? "- keyword location candidates from retrieved chunks"
            : "",
          inferredKeywordContext ? "- inferred keyword context from indexed tree" : "",
          repositorySignalContext
            ? "- implementation signals from indexed tree and package manifests"
            : "",
          workflowDocsContext ? "- repository workflow docs" : "",
          repoTreeContext ? "- capped repository tree snapshot" : "",
          "Answer this request from this manifest and the named context blocks.",
        ]
          .filter(Boolean)
          .join("\n")
      : "";

    const slimPromptQuestion = [
      question,
      modelContextManifest,
      requestDateContext,
      githubFactsForRagContext,
      commitDetailsForRagContext,
      recentCommitsForRagContext,
      questionEvidenceContext,
      priorChatContext,
    ]
      .filter(Boolean)
      .join("\n\n");

    const richPromptQuestion = [
      question,
      modelContextManifest,
      requestDateContext,
      priorChatContext,
      repositoryMetadataContext,
      aiSummaryForRagContext,
      commitDetailsForRagContext,
      githubFactsForRagContext,
      recentCommitsForRagContext,
      questionEvidenceContext,
      pathKindContext,
      directPathContext
        ? `Direct path context from user-mentioned files/folders:\n\n${directPathContext}`
        : "",
      authoritativeLocationContext,
      keywordLocationContext,
      inferredKeywordContext,
      githubFactsQuestion && !codebaseOverviewIntent && !summaryIntent
        ? ""
        : repositorySignalContext,
      workflowDocsContext,
      repoTreeContext,
    ]
      .filter(Boolean)
      .join("\n\n");
    const promptChunks =
      githubFactsQuestion && !locationLookupIntent && pathHints.length === 0
        ? []
        : chunks;

    const { system, user } = buildRagPrompt({
      repository: {
        owner: repoRow.github_owner,
        repo: repoRow.github_repo,
        commitSha: indexedSha,
      },
      originalQuestion: question,
      question: richPromptQuestion,
      contextChunks: promptChunks,
      readmeText,
    });
    const model = getHuggingFaceChatLanguageModel();

    const sourcePayload = chunks.map((c) => ({
      path: c.path,
      chunk_index: c.chunk_index,
      distance: c.distance,
    }));

    if (streamRequested === true) {
      const preferAccurateSingleAnswer =
        isMultiPartQuestion(question) ||
        locationLookupIntent ||
        pathHints.length > 0 ||
        question.trim().length > 90;
      if (preferAccurateSingleAnswer) {
        const generated = await generateText({
          model,
          system,
          prompt: user,
          temperature: 0,
        }).catch(async (error) => {
          if (!isProviderBadRequestError(error)) {
            throw error;
          }
          const slim = buildRagPrompt({
            repository: {
              owner: repoRow.github_owner,
              repo: repoRow.github_repo,
              commitSha: indexedSha,
            },
            originalQuestion: question,
            question: slimPromptQuestion,
            contextChunks: promptChunks.slice(0, 6),
            readmeText: null,
          });
          return generateText({
            model,
            system: slim.system,
            prompt: slim.user,
            temperature: 0,
          }).catch(() => {
            const ultraSlim = buildRagPrompt({
              repository: {
                owner: repoRow.github_owner,
                repo: repoRow.github_repo,
                commitSha: indexedSha,
              },
              originalQuestion: question,
              question: [
                question,
                requestDateContext,
                githubFactsForRagContext,
                commitDetailsForRagContext,
                recentCommitsForRagContext,
                questionEvidenceContext,
              ]
                .filter(Boolean)
                .join("\n\n"),
              contextChunks: [],
              readmeText: null,
            });
            return generateText({
              model,
              system: ultraSlim.system,
              prompt: ultraSlim.user,
              temperature: 0,
            });
          });
        });
        let generatedText = generated.text;
        const missingCoverageHints = collectMissingCoverageHints(
          question,
          generatedText,
        );
        if (missingCoverageHints.length > 0) {
          const retry = await generateText({
            model,
            system,
            prompt:
              `${user}\n\n` +
              "Coverage requirements for this question:\n" +
              missingCoverageHints.map((h) => `- ${h}`).join("\n") +
              "\n\nAnswer all required parts now using repository evidence only.",
            temperature: 0,
          }).catch(() => null);
          if (retry?.text?.trim()) {
            generatedText = retry.text;
          }
        }
        const normalizedAnswer = normalizeRagAnswer({
          answer: generatedText,
          question,
          locationLookupIntent,
          authoritativeLocationPaths,
          allowExternalLinks,
          verifiedTree: await getRepoTree(),
        });
        try {
          await persistChatTurn({
            supabase,
            chatId: persistedChatId,
            userQuestion: question,
            assistantAnswer: normalizedAnswer,
          });
        } catch (persistError) {
          console.warn(
            "[rag] chat persistence failed (single-answer mode):",
            persistError,
          );
        }
        const headers = new Headers();
        headers.set("Content-Type", "text/plain; charset=utf-8");
        headers.set("X-RepoLens-Commit-Sha", indexedSha);
        if (persistedChatId) {
          headers.set("X-RepoLens-Chat-Id", persistedChatId);
        }
        return new Response(normalizedAnswer, { status: 200, headers });
      }

      let streamSystem = system;
      let streamUser = user;
      let streamChunks = chunks;
      let streamReadme = readmeText;
      let result;
      try {
        result = streamText({
          model,
          system: streamSystem,
          prompt: streamUser,
          temperature: 0,
        });
      } catch (error) {
        if (!isProviderBadRequestError(error)) {
          throw error;
        }
        streamChunks = promptChunks.slice(0, 6);
        streamReadme = null;
        const slim = buildRagPrompt({
          repository: {
            owner: repoRow.github_owner,
            repo: repoRow.github_repo,
            commitSha: indexedSha,
          },
          originalQuestion: question,
          question: slimPromptQuestion,
          contextChunks: streamChunks,
          readmeText: streamReadme,
        });
        streamSystem = slim.system;
        streamUser = slim.user;
        result = streamText({
          model,
          system: streamSystem,
          prompt: streamUser,
          temperature: 0,
        });
      }
      const encoder = new TextEncoder();
      let streamedText = "";
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const delta of result.textStream) {
              const chunk = String(delta ?? "");
              if (!chunk) continue;
              streamedText += chunk;
              controller.enqueue(encoder.encode(chunk));
            }

            const completed = streamedText.trim();
            if (completed) {
              const verifiedTree = await getRepoTree();
              const normalizedAnswer = normalizeRagAnswer({
                answer: completed,
                question,
                locationLookupIntent,
                authoritativeLocationPaths,
                allowExternalLinks,
                verifiedTree,
              });
              try {
                await persistChatTurn({
                  supabase,
                  chatId: persistedChatId,
                  userQuestion: question,
                  assistantAnswer: normalizedAnswer,
                });
              } catch (persistError) {
                console.warn(
                  "[rag] chat persistence failed (stream):",
                  persistError,
                );
              }
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
      const headers = new Headers();
      headers.set("Content-Type", "text/plain; charset=utf-8");
      headers.set("X-RepoLens-Commit-Sha", indexedSha);
      if (persistedChatId) {
        headers.set("X-RepoLens-Chat-Id", persistedChatId);
      }
      return new Response(body, {
        status: 200,
        headers,
      });
    }

    const { text } = await generateText({
      model,
      system,
      prompt: user,
      temperature: 0,
    }).catch(async (error) => {
      if (!isProviderBadRequestError(error)) {
        throw error;
      }
      const slim = buildRagPrompt({
        repository: {
          owner: repoRow.github_owner,
          repo: repoRow.github_repo,
          commitSha: indexedSha,
        },
        originalQuestion: question,
        question: slimPromptQuestion,
        contextChunks: promptChunks.slice(0, 6),
        readmeText: null,
      });
      return generateText({
        model,
        system: slim.system,
        prompt: slim.user,
        temperature: 0,
      }).catch(() => {
        const ultraSlim = buildRagPrompt({
          repository: {
            owner: repoRow.github_owner,
            repo: repoRow.github_repo,
            commitSha: indexedSha,
          },
          originalQuestion: question,
          question: [
            question,
            requestDateContext,
            githubFactsForRagContext,
            commitDetailsForRagContext,
            recentCommitsForRagContext,
            questionEvidenceContext,
          ]
            .filter(Boolean)
            .join("\n\n"),
          contextChunks: [],
          readmeText: null,
        });
        return generateText({
          model,
          system: ultraSlim.system,
          prompt: ultraSlim.user,
          temperature: 0,
        });
      });
    });
    let finalText = text;
    const missingCoverageHints = collectMissingCoverageHints(question, finalText);
    if (missingCoverageHints.length > 0) {
      const retry = await generateText({
        model,
        system,
        prompt:
          `${user}\n\n` +
          "Coverage requirements for this question:\n" +
          missingCoverageHints.map((h) => `- ${h}`).join("\n") +
          "\n\nAnswer all required parts now using repository evidence only.",
        temperature: 0,
      }).catch(() => null);
      if (retry?.text?.trim()) {
        finalText = retry.text;
      }
    }
    const normalizedAnswer = normalizeRagAnswer({
      answer: finalText,
      question,
      locationLookupIntent,
      authoritativeLocationPaths,
      allowExternalLinks,
      verifiedTree: await getRepoTree(),
    });
    try {
      await persistChatTurn({
        supabase,
        chatId: persistedChatId,
        userQuestion: question,
        assistantAnswer: normalizedAnswer,
      });
    } catch (persistError) {
      console.warn("[rag] chat persistence failed:", persistError);
    }

    return NextResponse.json({
      answer: normalizedAnswer,
      commit_sha: indexedSha,
      chat_id: persistedChatId,
      sources: sourcePayload,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "RAG query failed";
    if (/function .* does not exist|match_repo_embeddings/i.test(message)) {
      return NextResponse.json(
        {
          error:
            "Similarity search is not installed. Run `supabase/manual/phase4-match-embeddings-rpc.sql` in the Supabase SQL editor.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: sanitizeErrorMessage(message) },
      { status: 500 },
    );
  }
}
