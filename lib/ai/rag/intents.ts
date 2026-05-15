export function isFolderInventoryIntent(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(folder|folders|directory|directories|tree|structure)\b/.test(q) ||
    /\bwhat(?:'s| is)?\s+inside\b/.test(q) ||
    /\blist\b.*\b(files?|folders?|directories?)\b/.test(q)
  );
}

export function isCodebaseOverviewIntent(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(whole|entire|overall)\s+(codebase|repo|repository)\b/.test(q) ||
    /\babout\s+(this|the)\s+(codebase|repo|repository)\b/.test(q) ||
    /\b(explain|describe|summarize)\b.*\b(codebase|repo|repository)\b/.test(q)
  );
}

export function isStructureDetailIntent(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(top[- ]level|file structure|project structure|structure|tree|directories|directory|folders?)\b/.test(
      q,
    ) || /\b(list|what(?:'s| is)? inside)\b/.test(q)
  );
}

export function isLocationLookupIntent(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(where|which|location|located|path)\b/.test(q) ||
    /\b(where can i|where do i|where is)\b/.test(q)
  );
}

export function isWorkflowGuidanceIntent(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(pr|pull request|merge request)\b/.test(q) ||
    /\b(contribute|contributing|contribution)\b/.test(q) ||
    /\b(how to update|how do i update|change docs|documentation change)\b/.test(
      q,
    )
  );
}

export function userExplicitlyAskedForExternalLinks(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(external|official)\s+docs?\b/.test(q) ||
    /\bshare\b.*\blink\b/.test(q) ||
    /\burl\b/.test(q) ||
    /https?:\/\//.test(q)
  );
}

export function userExplicitlyAskedToIgnoreReadme(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\bignore\b[\w\s-]{0,24}\breadme\b/.test(q) ||
    /\bwithout\b[\w\s-]{0,24}\breadme\b/.test(q) ||
    /\bnot\b[\w\s-]{0,24}\breadme\b/.test(q)
  );
}

export function isProviderBadRequestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /400 status code \(no body\)/i.test(message) ||
    /\b400\b.*status code/i.test(message) ||
    /\bbad request\b/i.test(message)
  );
}

export function isMultiPartQuestion(question: string): boolean {
  const q = question.toLowerCase();
  const questionMarks = (q.match(/\?/g) ?? []).length;
  return (
    /\b(and|also)\b/.test(q) ||
    questionMarks >= 2 ||
    (/\bwhere\b/.test(q) && /\bwhat\b/.test(q))
  );
}

export function collectMissingCoverageHints(
  question: string,
  answer: string,
): string[] {
  const q = question.toLowerCase();
  const a = answer.toLowerCase();
  const missing: string[] = [];

  const asksLocation =
    /\b(where|located|location|path)\b/.test(q) ||
    /\bwhere is\b/.test(q) ||
    /\bwhere are\b/.test(q);
  const asksTechnology =
    (/\bwhat\b/.test(q) || /\bwhich\b/.test(q)) &&
    /\b(used|using|provider|mechanism|system|technology|tech|auth|database|storage)\b/.test(
      q,
    );

  if (asksLocation) {
    const hasPath = /[a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+/.test(answer);
    if (!hasPath) {
      missing.push("Include concrete repository path(s) for location.");
    }
  }

  if (asksTechnology) {
    const hasTechSignal =
      /\b(use|uses|using|provider|oauth|session|token|supabase|nextauth|auth\.js|jwt|clerk|firebase|postgres|prisma)\b/.test(
        a,
      );
    if (!hasTechSignal) {
      missing.push("Explicitly name which technology/provider/mechanism is used.");
    }
  }

  if (isMultiPartQuestion(question)) {
    const connectiveCount = (q.match(/\b(and|also)\b/g) ?? []).length;
    const bulletOrStructuredCount = (answer.match(/\n[-*]\s/g) ?? []).length;
    if (connectiveCount > 0 && bulletOrStructuredCount === 0) {
      missing.push("Answer each part explicitly, ideally as separate bullets.");
    }
  }

  return missing;
}

export function isSummaryIntent(question: string): boolean {
  const q = question.toLowerCase();
  return (
    q.includes("summarize") ||
    q.includes("summary") ||
    q.includes("what this repository does") ||
    q.includes("who it is for")
  );
}

