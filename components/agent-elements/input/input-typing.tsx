import { useEffect, useReducer, useRef } from "react";

import {
  scheduleInputTypingAnimations,
  type TypingScheduleAction,
} from "./input-typing-schedule";

type TypingState = {
  visibleChars: number;
  showImage: boolean;
};

const initialTypingState: TypingState = {
  visibleChars: 0,
  showImage: false,
};

type TypingAction = { type: "reset" } | TypingScheduleAction;

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
      dispatch({ type: "reset" });
      return;
    }
    return scheduleInputTypingAnimations(dispatch, onCompleteRef, {
      text,
      duration,
    });
  }, [isActive, text, duration]);

  return {
    displayedText: text.slice(0, state.visibleChars),
    showImage: state.showImage,
  };
}
