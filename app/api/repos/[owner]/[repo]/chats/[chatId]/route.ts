import { NextResponse } from "next/server";
import { z } from "zod";

import { sanitizeErrorMessage } from "@/lib/security/sanitize-error-message";
import { createClient } from "@/lib/supabase/server";
import { requireSavedRepoAccess } from "@/lib/supabase/require-repo-for-user";

type RouteParams = {
  params: Promise<{ owner: string; repo: string; chatId: string }>;
};

const chatIdSchema = z.string().uuid();

async function requireChatOwnership(params: {
  ownerNorm: string;
  repoNorm: string;
  chatId: string;
}) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const repoLookup = await requireSavedRepoAccess(
    user.id,
    params.ownerNorm,
    params.repoNorm,
  );
  if (repoLookup.status === "db_error") {
    return {
      error: NextResponse.json(
        { error: sanitizeErrorMessage(repoLookup.message) },
        { status: 500 },
      ),
    };
  }
  if (repoLookup.status === "not_saved") {
    return {
      error: NextResponse.json(
        { error: "Repository not saved for this account" },
        { status: 403 },
      ),
    };
  }
  const repoRow = repoLookup.row;

  const { data: chatRow, error: chatErr } = await supabase
    .from("chats")
    .select("id, title, created_at, updated_at")
    .eq("id", params.chatId)
    .eq("user_id", user.id)
    .eq("repository_id", repoRow.id)
    .maybeSingle();
  if (chatErr) {
    return {
      error: NextResponse.json(
        { error: sanitizeErrorMessage(chatErr.message) },
        { status: 500 },
      ),
    };
  }
  if (!chatRow) {
    return { error: NextResponse.json({ error: "Chat not found" }, { status: 404 }) };
  }

  return { supabase, user, repoRow, chatRow };
}

export async function GET(_request: Request, { params }: RouteParams) {
  const { owner, repo, chatId } = await params;
  const parsed = chatIdSchema.safeParse(chatId);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid chat id" }, { status: 400 });
  }

  const context = await requireChatOwnership({
    ownerNorm: owner.toLowerCase(),
    repoNorm: repo.toLowerCase(),
    chatId: parsed.data,
  });
  if ("error" in context) return context.error;

  const { data: messages, error: messagesError } = await context.supabase
    .from("chat_messages")
    .select("id, role, content, created_at")
    .eq("chat_id", context.chatRow.id)
    .order("created_at", { ascending: true });
  if (messagesError) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(messagesError.message) },
      { status: 500 },
    );
  }

  return NextResponse.json({
    chat: context.chatRow,
    messages: messages ?? [],
  });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const { owner, repo, chatId } = await params;
  const parsed = chatIdSchema.safeParse(chatId);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid chat id" }, { status: 400 });
  }

  const context = await requireChatOwnership({
    ownerNorm: owner.toLowerCase(),
    repoNorm: repo.toLowerCase(),
    chatId: parsed.data,
  });
  if ("error" in context) return context.error;

  const { error: deleteMessagesError } = await context.supabase
    .from("chat_messages")
    .delete()
    .eq("chat_id", context.chatRow.id);
  if (deleteMessagesError) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(deleteMessagesError.message) },
      { status: 500 },
    );
  }

  const { error: deleteChatError } = await context.supabase
    .from("chats")
    .delete()
    .eq("id", context.chatRow.id);
  if (deleteChatError) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(deleteChatError.message) },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
