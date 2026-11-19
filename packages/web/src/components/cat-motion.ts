import type { CatAppearance, CatAppearanceId } from "./cat-catalog";

export type CatState = "idle" | "thinking" | "working" | "listening" | "speaking" | "waiting" | "success" | "error" | "offline";
export type CatFrame = 0 | 1 | 2 | 3;
export interface CatMotionStep { frame: CatFrame; nextIn: number | null }
type Pose = readonly [frame: CatFrame, duration: number];

export const CAT_SUCCESS_MS = 1500;
export const CAT_REACTION_MS = 900;
export const CAT_REACTION_COOLDOWN_MS = 3000;

const idle: readonly Pose[] = [[0, 5200], [1, 110], [0, 190]];
const sleeping: readonly Pose[] = [[0, 2100], [1, 650], [0, 1500], [2, 550], [0, 2900]];
const thinking: readonly Pose[] = [[2, 900], [0, 650]];
const working: readonly Pose[] = [[0, 480], [2, 350], [0, 650]];
const listening: readonly Pose[] = [[0, 700], [2, 450], [0, 950]];
const speaking: readonly Pose[] = [[0, 230], [2, 190], [0, 260], [2, 180], [0, 440]];
const success: readonly Pose[] = [[0, 140], [3, 440], [2, 280], [0, 640]];
const reaction: readonly Pose[] = [[3, 460], [2, 220], [0, 220]];
const waiting: readonly Pose[] = [[0, 160], [2, 620]];
const error: readonly Pose[] = [[2, 700]];
const still: Record<CatState, CatFrame> = {
  idle: 0, thinking: 2, working: 2, listening: 2, speaking: 2,
  waiting: 2, success: 3, error: 2, offline: 0,
};

function sequence(poses: readonly Pose[], elapsed: number, loop: boolean): CatMotionStep {
  const duration = poses.reduce((total, [, ms]) => total + ms, 0);
  let phase = Math.max(0, elapsed);
  if (loop) phase %= duration;
  for (const [frame, ms] of poses) {
    if (phase < ms) return { frame, nextIn: ms - phase };
    phase -= ms;
  }
  return { frame: 0, nextIn: null };
}

export function catCanReact(state: CatState): boolean {
  return state === "idle" || state === "listening";
}

export function catAppearanceForState(appearance: CatAppearance, state: CatState, composerAttention = false): CatAppearanceId {
  if (appearance !== "auto") return appearance;
  if (state === "working") return "programmer";
  if (state === "thinking") return "thinking";
  if (state === "listening") return composerAttention ? "closeup" : "headphones";
  if (state === "speaking") return "headphones";
  if (state === "waiting" || state === "error") return "waiting";
  if (state === "success") return "celebrate";
  return "sunglasses";
}

export function catIsSleeping(appearance: CatAppearanceId): boolean {
  return appearance.startsWith("sleep-") || appearance === "dozing";
}

export function catMotion(state: CatState, elapsed: number, options: {
  reduced?: boolean;
  sleeping?: boolean;
  reactionElapsed?: number;
} = {}): CatMotionStep {
  if (state === "offline") return { frame: 0, nextIn: null };
  if (options.reduced) return { frame: still[state === "success" && elapsed >= CAT_SUCCESS_MS ? "idle" : state], nextIn: null };
  const reactionElapsed = options.reactionElapsed;
  if (catCanReact(state) && reactionElapsed !== undefined && reactionElapsed >= 0 && reactionElapsed < CAT_REACTION_MS) {
    return sequence(reaction, reactionElapsed, false);
  }
  if (state === "success") return elapsed < CAT_SUCCESS_MS
    ? sequence(success, elapsed, false)
    : sequence(options.sleeping ? sleeping : idle, elapsed - CAT_SUCCESS_MS, true);
  if (state === "waiting") return elapsed < 780 ? sequence(waiting, elapsed, false) : sequence(idle, elapsed - 780, true);
  if (state === "error") return sequence(error, elapsed, false);
  if (state === "thinking") return sequence(thinking, elapsed, true);
  if (state === "working") return sequence(working, elapsed, true);
  if (state === "listening") return sequence(listening, elapsed, true);
  if (state === "speaking") return sequence(speaking, elapsed, true);
  return sequence(options.sleeping ? sleeping : idle, elapsed, true);
}

/** Idle advances at the next pose boundary; paused avatars hold no timer. */
export function createCatAnimationLoop(render: () => CatMotionStep) {
  let active = false, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function cancel() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function wake() {
    cancel();
    if (!active || disposed) return;
    const { nextIn } = render();
    if (nextIn !== null) timer = setTimeout(wake, Math.max(1, nextIn));
  }
  return {
    wake,
    setActive(next: boolean) { active = next; wake(); },
    dispose() { disposed = true; active = false; cancel(); },
  };
}
