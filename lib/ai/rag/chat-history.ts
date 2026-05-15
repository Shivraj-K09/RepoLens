import { createClient } from "@/lib/supabase/server";

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

