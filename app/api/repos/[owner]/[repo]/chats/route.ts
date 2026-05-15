import { NextResponse } from "next/server";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";
import { requireSavedRepoAccess } from "@/lib/supabase/require-repo-for-user";

type RouteParams = { params: Promise<{ owner: string; repo: string }> };

const createChatBodySchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

function fallbackTitleFromRepo(owner: string, repo: string): string {
  return `${owner}/${repo} chat`;
}

export async function GET(_request: Request, { params }: RouteParams) {
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

  const repoRow = await requireSavedRepoAccess(user.id, ownerNorm, repoNorm);
  if (!repoRow) {
    return NextResponse.json(
      { error: "Repository not saved for this account" },
      { status: 403 },
    );
  }

  const { data: chats, error: chatsError } = await supabase
    .from("chats")
    .select("id, title, created_at, updated_at")
    .eq("user_id", user.id)
    .eq("repository_id", repoRow.id)
    .order("updated_at", { ascending: false })
    .limit(60);
  if (chatsError) {
    return NextResponse.json({ error: chatsError.message }, { status: 500 });
  }

  const chatIds = (chats ?? []).map((c) => c.id).filter(Boolean);
  if (chatIds.length === 0) {
    return NextResponse.json({ chats: [] });
  }

  const { data: messages, error: messagesError } = await supabase
    .from("chat_messages")
    .select("chat_id, role, content, created_at")
    .in("chat_id", chatIds)
    .order("created_at", { ascending: false });
  if (messagesError) {
    return NextResponse.json({ error: messagesError.message }, { status: 500 });
  }

  const latestByChat = new Map<
    string,
    { role: string; content: string; created_at: string }
  >();
  const countByChat = new Map<string, number>();
  for (const message of messages ?? []) {
    const chatId = message.chat_id as string;
    if (!chatId) continue;
    countByChat.set(chatId, (countByChat.get(chatId) ?? 0) + 1);
    if (!latestByChat.has(chatId)) {
      latestByChat.set(chatId, {
        role: String(message.role ?? ""),
        content: String(message.content ?? ""),
        created_at: String(message.created_at ?? ""),
      });
    }
  }

  const payload = (chats ?? []).map((chat) => {
    const latest = latestByChat.get(chat.id);
    return {
      id: chat.id,
      title:
        typeof chat.title === "string" && chat.title.trim()
          ? chat.title.trim()
          : fallbackTitleFromRepo(repoRow.github_owner, repoRow.github_repo),
      created_at: chat.created_at,
      updated_at: chat.updated_at,
      message_count: countByChat.get(chat.id) ?? 0,
      latest_message: latest ?? null,
    };
  });

  return NextResponse.json({ chats: payload });
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

  const repoRow = await requireSavedRepoAccess(user.id, ownerNorm, repoNorm);
  if (!repoRow) {
    return NextResponse.json(
      { error: "Repository not saved for this account" },
      { status: 403 },
    );
  }

  let json: unknown = {};
  try {
    json = await request.json();
  } catch {
    // allow empty body
  }
  const parsed = createChatBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const title =
    parsed.data.title?.trim() ||
    fallbackTitleFromRepo(repoRow.github_owner, repoRow.github_repo);

  const { data, error } = await supabase
    .from("chats")
    .insert({
      user_id: user.id,
      repository_id: repoRow.id,
      title,
    })
    .select("id, title, created_at, updated_at")
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Insert failed" }, { status: 500 });
  }

  return NextResponse.json({ chat: data }, { status: 201 });
}
