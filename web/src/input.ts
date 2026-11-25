export const KEY = { forward: 1, back: 2, left: 4, right: 8, sneak: 16, jump: 32, attack: 64, use: 128, sprint: 256 } as const;
export type Ui = "play" | "menu" | "inventory";

export interface InputFrame {
  keys: number;
  taps: number;
  dyaw: number;
  dpitch: number;
  snap: -1 | 0 | 1;
  slot: number | null;
  iceToggle: boolean;
  ui: Ui;
}

export const MOUSE_DEGREES_PER_PIXEL = 0.15;
export const TOUCH_DEGREES_PER_PIXEL = 0.25;
export const MAX_FRAME_YAW = 180;
export const MAX_FRAME_PITCH = 45;
const MAX_EVENT_PIXELS = 400;
const YAW_RATE = 193;
const PITCH_RATE = 151;
const PRECISE_RATE = 40;

const movement: Record<string, number> = {
  KeyW: KEY.forward, KeyS: KEY.back, KeyA: KEY.left, KeyD: KEY.right, Space: KEY.jump,
  ShiftLeft: KEY.sneak, ShiftRight: KEY.sneak, ControlLeft: KEY.sprint, KeyR: KEY.sprint, KeyQ: KEY.sprint, KeyU: KEY.attack, KeyI: KEY.use,
};
const turning = new Set(["KeyH", "KeyL", "KeyJ", "KeyK"]);

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

export class InputState {
  private down = new Set<string>();
  private buttons = new Set<number>();
  private touch = 0;
  private ui: Ui = "play";
  private edges = new Map<number, number>();
  private dyaw = 0;
  private dpitch = 0;
  private snap: -1 | 0 | 1 = 0;
  private slot: number | null = null;
  private iceToggle = false;
  private last = 0;

  private mask(): number {
    let mask = 0;
    for (const code of this.down) mask |= movement[code] ?? 0;
    if (this.buttons.has(0)) mask |= KEY.attack;
    if (this.buttons.has(2)) mask |= KEY.use;
    mask |= this.touch;
    if (!(mask & KEY.forward)) mask &= ~KEY.sprint;
    return mask;
  }

  private advance(now: number): void {
    const dt = Math.max(0, Math.min(250, now - this.last)) / 1000;
    this.last = now;
    if (dt === 0 || this.ui !== "play") return;
    const shift = this.down.has("ShiftLeft");
    const precise = this.down.has("KeyC");
    const yaw = precise ? PRECISE_RATE : YAW_RATE;
    const pitch = precise ? PRECISE_RATE : PITCH_RATE;
    if (!shift) {
      this.dyaw += ((this.down.has("KeyL") ? 1 : 0) - (this.down.has("KeyH") ? 1 : 0)) * yaw * dt;
    }
    this.dpitch += ((this.down.has("KeyJ") ? 1 : 0) - (this.down.has("KeyK") ? 1 : 0)) * pitch * dt;
  }

  private pressing(before: number, after: number): void {
    for (const action of [KEY.jump, KEY.attack, KEY.use]) {
      if (!(before & action) && after & action) this.edges.set(action, (this.edges.get(action) ?? 0) + 1);
    }
  }

  setUi(ui: Ui, now: number): void {
    this.advance(now);
    if (ui === this.ui) return;
    this.ui = ui;
    this.clear(now);
  }

  clear(now: number): void {
    this.advance(now);
    this.down.clear();
    this.buttons.clear();
    this.touch = 0;
    this.edges.clear();
    this.dyaw = this.dpitch = 0;
    this.snap = 0;
    this.slot = null;
    this.iceToggle = false;
  }

  requeueIce(): void {
    if (this.ui === "play") this.iceToggle = true;
  }

  keyDown(code: string, now: number, repeat = false): void {
    if (this.ui !== "play") return;
    this.advance(now);
    if (repeat || this.down.has(code)) return;
    if (code === "Backspace") {
      this.iceToggle = !this.iceToggle;
      return;
    }
    const before = this.mask();
    if (turning.has(code) || code === "KeyC") {
      this.down.add(code);
      if ((code === "KeyH" || code === "KeyL") && this.down.has("ShiftLeft")) this.snap = code === "KeyH" ? -1 : 1;
      return;
    }
    const digit = /^Digit([1-9])$/.exec(code);
    if (digit) {
      this.slot = Number(digit[1]) - 1;
      return;
    }
    if (!(code in movement)) return;
    this.down.add(code);
    this.pressing(before, this.mask());
  }

  keyUp(code: string, now: number): void {
    if (this.ui !== "play") return;
    this.advance(now);
    this.down.delete(code);
  }

  mouseDown(button: number, now: number): void {
    if (this.ui !== "play" || (button !== 0 && button !== 2)) return;
    this.advance(now);
    const before = this.mask();
    this.buttons.add(button);
    this.pressing(before, this.mask());
  }

  mouseUp(button: number, now: number): void {
    if (this.ui !== "play") return;
    this.advance(now);
    this.buttons.delete(button);
  }

  touchKeys(bits: number, now: number): void {
    if (this.ui !== "play") return;
    this.advance(now);
    const before = this.mask();
    this.touch = bits;
    this.pressing(before, this.mask());
  }

  touchAbort(bits: number): void {
    for (const action of [KEY.jump, KEY.attack, KEY.use]) if (bits & action) this.edges.delete(action);
  }

  touchLook(dx: number, dy: number, now: number): void {
    if (this.ui !== "play") return;
    this.advance(now);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.dyaw += clamp(dx, MAX_EVENT_PIXELS) * TOUCH_DEGREES_PER_PIXEL;
    this.dpitch += clamp(dy, MAX_EVENT_PIXELS) * TOUCH_DEGREES_PER_PIXEL;
  }

  mouseMove(dx: number, dy: number, now: number): void {
    if (this.ui !== "play") return;
    this.advance(now);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.dyaw += clamp(dx, MAX_EVENT_PIXELS) * MOUSE_DEGREES_PER_PIXEL;
    this.dpitch += clamp(dy, MAX_EVENT_PIXELS) * MOUSE_DEGREES_PER_PIXEL;
  }

  frame(now: number): InputFrame {
    this.advance(now);
    const play = this.ui === "play";
    const mask = this.mask();
    let taps = 0;
    if (play) {
      const short = (action: number) => Math.max(0, (this.edges.get(action) ?? 0) - (mask & action ? 1 : 0)) > 0;
      if (short(KEY.jump)) taps |= 1;
      if (short(KEY.attack)) taps |= 2;
      if (short(KEY.use)) taps |= 4;
    }
    const frame: InputFrame = {
      keys: play ? mask : 0,
      taps,
      dyaw: clamp(this.dyaw, MAX_FRAME_YAW),
      dpitch: clamp(this.dpitch, MAX_FRAME_PITCH),
      snap: this.snap,
      slot: this.slot,
      iceToggle: play && this.iceToggle,
      ui: this.ui,
    };
    this.edges.clear();
    this.dyaw = this.dpitch = 0;
    this.snap = 0;
    this.slot = null;
    this.iceToggle = false;
    return frame;
  }
}
