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
import { persistChatTurn } from "@/lib/ai/rag/chat-history";
import {
  buildDirectPathContext,
  buildInferredKeywordContext,
  buildMentionedPathKindContext,
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
  /** Override default number of chunks (max 32 in SQL). */
  match_count: z.number().int().min(1).max(32).optional(),
  /** Optional persisted chat id for history. */
  chat_id: z.string().uuid().optional(),
});

type RouteParams = { params: Promise<{ owner: string; repo: string }> };

const SEMANTIC_SEARCH_TIMEOUT_MS = 3000;
const CONTEXT_ENRICHMENT_TIMEOUT_MS = 1800;

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
    match_count,
    chat_id,
  } = parsed.data;
  const summaryIntent = isSummaryIntent(question);
  const pathHints = extractPathHints(question);
  const keywordHints = extractKeywordHints(question);
  const folderInventoryIntent = isFolderInventoryIntent(question);
  const codebaseOverviewIntent = isCodebaseOverviewIntent(question);
  const structureDetailIntent = isStructureDetailIntent(question);
  const locationLookupIntent = isLocationLookupIntent(question);
  const workflowGuidanceIntent = isWorkflowGuidanceIntent(question);
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
      chunks.length === 0 && pathHints.length === 0
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

    const richPromptQuestion = [
      question,
      repositoryMetadataContext,
      pathKindContext,
      directPathContext
        ? `Direct path context from user-mentioned files/folders:\n\n${directPathContext}`
        : "",
      authoritativeLocationContext,
      keywordLocationContext,
      inferredKeywordContext,
      repositorySignalContext,
      workflowDocsContext,
      repoTreeContext,
    ]
      .filter(Boolean)
      .join("\n\n");

    const { system, user } = buildRagPrompt({
      repository: {
        owner: repoRow.github_owner,
        repo: repoRow.github_repo,
        commitSha: indexedSha,
      },
      originalQuestion: question,
      question: richPromptQuestion,
      contextChunks: chunks,
      readmeText,
    });
    const model = getHuggingFaceChatLanguageModel();

    const sourcePayload = chunks.map((c) => ({
      path: c.path,
      chunk_index: c.chunk_index,
      distance: c.distance,
    }));

    if (streamRequested === true) {
      const preferAccurateSingleAnswer = isMultiPartQuestion(question);
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
            question,
            contextChunks: chunks.slice(0, 8),
            readmeText: null,
          });
          return generateText({
            model,
            system: slim.system,
            prompt: slim.user,
            temperature: 0,
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
        streamChunks = chunks.slice(0, 8);
        streamReadme = null;
        const slim = buildRagPrompt({
          repository: {
            owner: repoRow.github_owner,
            repo: repoRow.github_repo,
            commitSha: indexedSha,
          },
          question,
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
        question,
        contextChunks: chunks.slice(0, 8),
        readmeText: null,
      });
      return generateText({
        model,
        system: slim.system,
        prompt: slim.user,
        temperature: 0,
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
