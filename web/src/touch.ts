import { KEY } from "./input.js";

export type Hold = "attack" | "use" | "jump";

export interface TouchSink {
  keys(bits: number): void;
  look(dx: number, dy: number): void;
  abort(bits: number): void;
}

export const STICK_RADIUS = 56;
const DEAD_ZONE = 0.3;
const AXIS_SECTOR = 0.38;
const TAP_MS = 60;
const HOLD_KEY: Record<Hold, number> = { attack: KEY.attack, use: KEY.use, jump: KEY.jump };

interface Track {
  x: number;
  y: number;
}

export class TouchSurface {
  private stick = new Map<number, Track & { dx: number; dy: number }>();
  private look = new Map<number, Track>();
  private holds = new Map<number, Hold>();
  private taps = new Map<Hold, ReturnType<typeof setTimeout>>();
  private sprintOn = false;
  private sneakOn = false;
  private published = 0;

  constructor(private readonly sink: TouchSink) {}

  get sprint(): boolean {
    return this.sprintOn;
  }

  get sneak(): boolean {
    return this.sneakOn;
  }

  get stickOffset(): { x: number; y: number } | null {
    const first = this.stick.values().next().value;
    return first ? { x: first.dx, y: first.dy } : null;
  }

  get active(): boolean {
    return this.stick.size + this.look.size + this.holds.size > 0;
  }

  beginStick(id: number, x: number, y: number): boolean {
    if (this.stick.size) return false;
    this.stick.set(id, { x, y, dx: 0, dy: 0 });
    return true;
  }

  beginLook(id: number, x: number, y: number): boolean {
    if (this.look.size) return false;
    this.look.set(id, { x, y });
    return true;
  }

  beginHold(id: number, hold: Hold): boolean {
    if (this.holds.has(id)) return false;
    this.holds.set(id, hold);
    this.publish();
    return true;
  }

  move(id: number, x: number, y: number): void {
    const stick = this.stick.get(id);
    if (stick) {
      let dx = x - stick.x;
      let dy = y - stick.y;
      const length = Math.hypot(dx, dy);
      if (length > STICK_RADIUS) {
        dx = (dx / length) * STICK_RADIUS;
        dy = (dy / length) * STICK_RADIUS;
      }
      stick.dx = Number.isFinite(dx) ? dx : 0;
      stick.dy = Number.isFinite(dy) ? dy : 0;
      this.publish();
      return;
    }
    const look = this.look.get(id);
    if (look) {
      const dx = x - look.x;
      const dy = y - look.y;
      look.x = x;
      look.y = y;
      this.sink.look(dx, dy);
    }
  }

  end(id: number): void {
    this.stick.delete(id);
    this.look.delete(id);
    this.holds.delete(id);
    this.publish();
  }

  toggleSprint(): boolean {
    this.sprintOn = !this.sprintOn;
    if (this.sprintOn) this.sneakOn = false;
    this.publish();
    return this.sprintOn;
  }

  toggleSneak(): boolean {
    this.sneakOn = !this.sneakOn;
    if (this.sneakOn) this.sprintOn = false;
    this.publish();
    return this.sneakOn;
  }

  tap(hold: Hold): void {
    clearTimeout(this.taps.get(hold));
    this.taps.set(hold, setTimeout(() => {
      this.taps.delete(hold);
      this.publish();
    }, TAP_MS));
    this.publish();
  }

  lose(id: number): void {
    const hold = this.holds.get(id);
    if (!this.stick.has(id) && !this.look.has(id) && hold === undefined) return;
    this.end(id);
    this.sprintOn = this.sneakOn = false;
    this.publish();
    if (hold) this.sink.abort(HOLD_KEY[hold]);
  }

  cancel(): void {
    this.stick.clear();
    this.look.clear();
    this.holds.clear();
    for (const timer of this.taps.values()) clearTimeout(timer);
    this.taps.clear();
    this.sprintOn = this.sneakOn = false;
    this.publish();
    this.sink.abort(KEY.attack | KEY.use | KEY.jump);
  }

  private bits(): number {
    let bits = 0;
    const stick = this.stick.values().next().value;
    if (stick) {
      const length = Math.hypot(stick.dx, stick.dy);
      if (length >= STICK_RADIUS * DEAD_ZONE) {
        const nx = stick.dx / length;
        const ny = stick.dy / length;
        if (ny < -AXIS_SECTOR) bits |= KEY.forward;
        if (ny > AXIS_SECTOR) bits |= KEY.back;
        if (nx < -AXIS_SECTOR) bits |= KEY.left;
        if (nx > AXIS_SECTOR) bits |= KEY.right;
      }
    }
    for (const hold of this.holds.values()) bits |= HOLD_KEY[hold];
    for (const hold of this.taps.keys()) bits |= HOLD_KEY[hold];
    if (this.sprintOn) bits |= KEY.sprint;
    if (this.sneakOn) bits |= KEY.sneak;
    return bits;
  }

  private publish(): void {
    const bits = this.bits();
    if (bits === this.published) return;
    this.published = bits;
    this.sink.keys(bits);
  }
}
