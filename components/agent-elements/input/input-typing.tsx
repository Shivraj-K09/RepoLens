import { useEffect, useReducer, useRef } from "react";

type TypingState = {
  visibleChars: number;
  showImage: boolean;
};

const initialTypingState: TypingState = {
  visibleChars: 0,
  showImage: false,
};

type TypingAction =
  | { type: "reset" }
  | { type: "patch"; patch: Partial<TypingState> };

function typingReducer(state: TypingState, action: TypingAction): TypingState {
  switch (action.type) {
    case "reset":
      return initialTypingState;
    case "patch":
      return { ...state, ...action.patch };
  }
}

type RunTypingParams = {
  text: string;
  duration: number;
  isActive: boolean;
  dispatch: React.Dispatch<TypingAction>;
  onCompleteRef: React.MutableRefObject<() => void>;
};

/** Single source of truth for the typing animation; effect calls this once. */
function runTypingAnimation({
  text,
  duration,
  isActive,
  dispatch,
  onCompleteRef,
}: RunTypingParams): () => void {
  if (!isActive) {
    dispatch({ type: "reset" });
    return () => {};
  }

  const imageDelay = duration * 0.1;
  const typingStart = duration * 0.15;
  const typingDuration = duration * 0.7;
  const charInterval =
    text.length > 0 ? typingDuration / text.length : typingDuration;
  const sendDelay = duration * 0.15;
  const totalEnd = typingStart + typingDuration + sendDelay;

  let rafId = 0;
  let cancelled = false;
  const t0 = performance.now();

  const tick = (now: number) => {
    if (cancelled) return;
    const elapsed = now - t0;
    const showImage = elapsed >= imageDelay;
    const visibleChars =
      elapsed >= typingStart && text.length > 0
        ? Math.min(
            text.length,
            Math.floor((elapsed - typingStart) / charInterval) + 1,
          )
        : 0;

    dispatch({ type: "patch", patch: { showImage, visibleChars } });

    if (elapsed >= totalEnd) {
      onCompleteRef.current();
      return;
    }
    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    cancelAnimationFrame(rafId);
  };
}

export function useInputTyping(
  text: string,
  duration: number,
  isActive: boolean,
  onComplete: () => void,
) {
  const [state, dispatch] = useReducer(typingReducer, initialTypingState);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(
    () =>
      runTypingAnimation({
        text,
        duration,
        isActive,
        dispatch,
        onCompleteRef,
      }),
    [isActive, text, duration],
  );

  return {
    displayedText: text.slice(0, state.visibleChars),
    showImage: state.showImage,
  };
}
