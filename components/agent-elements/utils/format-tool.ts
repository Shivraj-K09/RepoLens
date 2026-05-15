import type { AgentToolPart } from "../types";

export function toolInputRecord(part: AgentToolPart): Record<string, unknown> {
  const v = part.input;
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function toolOutputRecord(part: AgentToolPart): Record<string, unknown> {
  const v = part.output;
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function toolArgsMerged(part: AgentToolPart): Record<string, unknown> {
  const a = part.args;
  const argsObj =
    a !== null && typeof a === "object" && !Array.isArray(a)
      ? (a as Record<string, unknown>)
      : {};
  return { ...argsObj, ...toolInputRecord(part) };
}

type CachedToolState = {
  state: string | undefined;
  inputJson: string;
  outputJson: string;
};

const toolStateCache = new Map<string, CachedToolState>();

function getToolStateSnapshot(part: AgentToolPart): CachedToolState {
  return {
    state: part.state,
    inputJson: JSON.stringify(part.input ?? {}),
    outputJson: JSON.stringify(part.output ?? {}),
  };
}

function hasToolStateChanged(toolCallId: string, part: AgentToolPart): boolean {
  const cached = toolStateCache.get(toolCallId);
  const current = getToolStateSnapshot(part);

  if (!cached) {
    toolStateCache.set(toolCallId, current);
    return true;
  }

  const changed =
    cached.state !== current.state ||
    cached.inputJson !== current.inputJson ||
    cached.outputJson !== current.outputJson;

  if (changed) {
    toolStateCache.set(toolCallId, current);
  }

  return changed;
}

function arePartsEqual(prev: AgentToolPart, next: AgentToolPart): boolean {
  if (prev.toolCallId !== next.toolCallId) return false;
  if (prev.type !== next.type) return false;

  const toolCallId = next.toolCallId;
  if (!toolCallId) {
    return prev.state === next.state;
  }

  const changed = hasToolStateChanged(toolCallId, next);
  return !changed;
}

function isToolCompleted(part: AgentToolPart): boolean {
  if (part.output !== undefined && part.output !== null) return true;
  if (part.state === "error") return true;
  if (part.state === "result") return true;
  return false;
}

/** Deep compare function for tool part props. Used with React.memo(). */
export function areToolPropsEqual(
  prevProps: { part: AgentToolPart; chatStatus?: string },
  nextProps: { part: AgentToolPart; chatStatus?: string },
): boolean {
  const partsEqual = arePartsEqual(prevProps.part, nextProps.part);
  if (!partsEqual) return false;
  if (isToolCompleted(nextProps.part)) return true;
  if (prevProps.chatStatus !== nextProps.chatStatus) return false;
  return true;
}

/** Get tool status from part state */
export function getToolStatus(part: AgentToolPart, chatStatus?: string) {
  const basePending =
    part.state !== "output-available" && part.state !== "output-error";
  const outputRecord =
    typeof part.output === "object" && part.output !== null
      ? (part.output as { success?: boolean })
      : null;
  const isError =
    part.state === "output-error" ||
    (part.state === "output-available" && outputRecord?.success === false);
  const isSuccess = part.state === "output-available" && !isError;
  const isPending = basePending && chatStatus === "streaming";
  const isInterrupted =
    basePending && chatStatus !== "streaming" && chatStatus !== undefined;

  return { isPending, isError, isSuccess, isInterrupted };
}
