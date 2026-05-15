const QUESTION_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "could",
  "do",
  "does",
  "for",
  "from",
  "in",
  "inside",
  "is",
  "it",
  "kind",
  "me",
  "of",
  "on",
  "or",
  "please",
  "tell",
  "that",
  "the",
  "there",
  "this",
  "to",
  "types",
  "what",
  "which",
  "you",
  "your",
  "folder",
  "file",
  "components",
  "component",
]);

export function extractPathHints(question: string): string[] {
  const uniq: string[] = [];

  function pushHint(v: string, options?: { allowBare?: boolean }) {
    const allowBare = options?.allowBare === true;
    const clean = v
      .trim()
      .replace(/^@/, "")
      .replace(/[.,;:!?]+$/, "");
    if (!clean) return;
    if (clean.length < 2) return;
    if (!allowBare && !clean.includes("/") && !clean.startsWith(".")) return;
    if (!uniq.includes(clean)) uniq.push(clean);
  }

  for (const m of question.matchAll(/@([^\s`"'()<>]+)/g)) {
    const v = m[1];
    if (typeof v === "string") pushHint(v, { allowBare: true });
    if (uniq.length >= 6) return uniq;
  }

  for (const m of question.matchAll(/`([^`]+)`/g)) {
    const v = m[1];
    if (typeof v === "string") pushHint(v);
    if (uniq.length >= 6) return uniq;
  }

  for (const m of question.matchAll(
    /(?:^|\s)([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+)(?=\s|$)/g,
  )) {
    const v = m[1];
    if (typeof v === "string") pushHint(v);
    if (uniq.length >= 6) return uniq;
  }

  for (const m of question.matchAll(/\b([a-zA-Z0-9._-]+)\s+folder\b/gi)) {
    const v = m[1];
    if (typeof v === "string") pushHint(v, { allowBare: true });
    if (uniq.length >= 6) return uniq;
  }

  return uniq;
}

export function extractKeywordHints(question: string): string[] {
  const words = (question.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? [])
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !QUESTION_STOPWORDS.has(w));
  const uniq: string[] = [];
  for (const w of words) {
    if (!uniq.includes(w)) uniq.push(w);
  }
  for (let i = 0; i < words.length - 1; i += 1) {
    const a = words[i];
    const b = words[i + 1];
    if (!a || !b) continue;
    const hyphen = `${a}-${b}`;
    const slash = `${a}/${b}`;
    if (!uniq.includes(hyphen)) uniq.push(hyphen);
    if (!uniq.includes(slash)) uniq.push(slash);
  }
  return uniq.slice(0, 6);
}

export function scorePathWithHints(path: string, hints: string[]): number {
  const p = path.toLowerCase();
  let score = 0;
  for (const hint of hints) {
    const h = hint.toLowerCase();
    if (!h) continue;
    if (p === h) score += 120;
    if (p.endsWith(`/${h}`)) score += 80;
    if (p.includes(`/${h}/`)) score += 70;
    if (p.includes(h)) score += 40;
    const compressedPath = p.replace(/[-_/]/g, "");
    const compressedHint = h.replace(/[-_/]/g, "");
    if (compressedHint.length >= 3 && compressedPath.includes(compressedHint)) {
      score += 20;
    }
  }
  return score;
}

