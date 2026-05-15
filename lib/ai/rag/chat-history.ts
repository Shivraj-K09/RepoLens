import { createClient } from "@/lib/supabase/server";

const RAG_HISTORY_MAX_MESSAGES = 36;
const RAG_HISTORY_MAX_CHARS = 14_000;

function stripLeakedContextManifest(text: string): string {
  const manifestLine =
    /^\s*(?:[-*]\s*)?(?:system instructions from buildRagPrompt|repository header: owner, repo, indexed commit SHA|semantic RAG chunks:|user question enriched with request date context|prior chat history:|saved repository metadata snapshot|cached repository AI summary|focused GitHub commit detail|question-targeted live GitHub facts|recent default-branch commits|resolved mentioned path kinds|direct file\/folder context|authoritative location candidates|keyword location candidates|inferred keyword context|repository implementation signals|repository workflow docs|repository tree snapshot|Model context manifest for this request)/i;

  return text
    .split("\n")
    .filter((line) => !manifestLine.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Prior turns in this chat, formatted for the RAG user payload.
 * Excludes the current request (those rows are not persisted yet).
 */
export async function fetchChatHistoryBlockForRag(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  chatId: string;
  maxMessages?: number;
  maxChars?: number;
}): Promise<string> {
  const maxMsg = Math.min(
    48,
    Math.max(2, params.maxMessages ?? RAG_HISTORY_MAX_MESSAGES),
  );
  const maxChars = Math.min(
    32_000,
    Math.max(500, params.maxChars ?? RAG_HISTORY_MAX_CHARS),
  );

  const { data, error } = await params.supabase
    .from("chat_messages")
    .select("role, content, created_at")
    .eq("chat_id", params.chatId)
    .order("created_at", { ascending: false })
    .limit(maxMsg);

  if (error || !data?.length) {
    return "";
  }

  const chronological = [...data].reverse();

  const lines: string[] = [];
  for (const m of chronological) {
    const text = stripLeakedContextManifest(String(m.content ?? "").trim());
    if (!text) continue;
    const role = m.role === "assistant" ? "Assistant" : "User";
    lines.push(`${role}: ${text}`);
  }

  if (lines.length === 0) return "";

  const header =
    "Prior messages in this chat (same repository). Use them to resolve follow-ups such as \"that\", \"it\", \"the title for that commit\", or \"that commit\" — prefer the most recent Assistant answer when it identifies a specific commit SHA or topic:";

  while (lines.length > 0) {
    const body = lines.join("\n");
    if (header.length + 1 + body.length <= maxChars) {
      return `${header}\n${body}`;
    }
    lines.shift(); // drop oldest until we fit (keep recent turns for pronouns / SHAs)
  }

  return "";
}

export async function persistChatTurn(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  chatId: string | null;
  userQuestion: string;
  assistantAnswer: string;
}) {
  if (!params.chatId) return;
  const userText = params.userQuestion.trim();
  const assistantText = params.assistantAnswer.trim();
  if (!userText || !assistantText) return;

  const { error: insertError } = await params.supabase
    .from("chat_messages")
    .insert([
      { chat_id: params.chatId, role: "user", content: userText },
      { chat_id: params.chatId, role: "assistant", content: assistantText },
    ]);
  if (insertError) throw new Error(insertError.message);

  const { error: touchError } = await params.supabase
    .from("chats")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", params.chatId);
  if (touchError) throw new Error(touchError.message);
}
