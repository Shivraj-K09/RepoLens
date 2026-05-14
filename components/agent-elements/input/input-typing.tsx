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

  useEffect(() => {
    if (!isActive) {
      queueMicrotask(() => dispatch({ type: "reset" }));
      return;
    }

    const imageDelay = duration * 0.1;
    const typingStart = duration * 0.15;
    const typingDuration = duration * 0.7;
    const charInterval =
      text.length > 0 ? typingDuration / text.length : typingDuration;
    const sendDelay = duration * 0.15;
    const timers: ReturnType<typeof setTimeout>[] = [];

    timers.push(
      setTimeout(() => dispatch({ type: "patch", patch: { showImage: true } }), imageDelay),
    );
    for (let i = 0; i < text.length; i++) {
      timers.push(
        setTimeout(
          () => dispatch({ type: "patch", patch: { visibleChars: i + 1 } }),
          typingStart + charInterval * i,
        ),
      );
    }
    timers.push(
      setTimeout(
        () => onCompleteRef.current(),
        typingStart + typingDuration + sendDelay,
      ),
    );

    return () => {
      for (const id of timers) clearTimeout(id);
    };
  }, [isActive, text, duration]);

  return {
    displayedText: text.slice(0, state.visibleChars),
    showImage: state.showImage,
  };
}
