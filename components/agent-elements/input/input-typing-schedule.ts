import type { MutableRefObject } from "react";

/** Actions dispatched by the typing timer scheduler (not including synchronous reset). */
export type TypingScheduleAction = {
  type: "patch";
  patch: Partial<{ visibleChars: number; showImage: boolean }>;
};

/** Registers timeouts for the staged typing animation; returns cleanup that clears them. */
export function scheduleInputTypingAnimations(
  dispatch: (action: TypingScheduleAction) => void,
  onCompleteRef: MutableRefObject<() => void>,
  params: { text: string; duration: number },
): () => void {
  const { text, duration } = params;
  const imageDelay = duration * 0.1;
  const typingStart = duration * 0.15;
  const typingDuration = duration * 0.7;
  const charInterval =
    text.length > 0 ? typingDuration / text.length : typingDuration;
  const sendDelay = duration * 0.15;
  const timers: ReturnType<typeof setTimeout>[] = [];

  timers.push(
    setTimeout(
      () => dispatch({ type: "patch", patch: { showImage: true } }),
      imageDelay,
    ),
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
}
