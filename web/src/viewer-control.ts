import { outgoing } from "./chat.js";
import { ControlMachine, type Mode } from "./control.js";
import { InputState } from "./input.js";
import { buildClick, canHandBack, type ClickOp } from "./inventory.js";
import type { Vec3 } from "./renderer.js";
import type { Checkpoint, ControlInfo, InventorySnapshot, TerrainBatch } from "./wire.js";

export interface ControlView {
  mode: Mode;
  label: string;
  canReturn: boolean;
  canPlay: boolean;
  canResume: boolean;
  canRestart: boolean;
  checkpoint: Checkpoint;
  notice: string;
  denied: boolean;
  chatOpen: boolean;
  chatSeed: string;
  chatNote: string;
}

interface ControlSink {
  state(view: ControlView): void;
  lock(): void;
  unlock(): void;
  inventory(inv: InventorySnapshot | null): void;
  marker(point: Vec3 | null): void;
  say?(grant: number, id: number, text: string): Promise<"sent" | "rejected" | "limited" | "failed">;
}

type Shot = { seq: number; args: number[]; sentAt: number };

const ONE_SHOT_TIMEOUT_MS = 3000;
const ESCAPE_ECHO_MS = 100;
const KIND = { pause: 0, play: 1, inventory: 2, click: 3, close: 4, ret: 5, intervene: 6, resume: 7, restart: 8, chat: 9 } as const;
const CHAT_NOTICE_MS = 4000;

const centi = (degrees: number, limit: number) => Math.max(-limit, Math.min(limit, Math.round(degrees * 100)));

function wrapDegrees(value: number): number {
  return ((value + 540) % 360) - 180;
}

export class ViewerControl {
  private readonly input = new InputState();
  private readonly machine: ControlMachine;
  private info: ControlInfo | null = null;
  private queued: number[][] = [];
  private shot: Shot | null = null;
  private sequence = 0;
  private settle = 0;
  private following = false;
  private playSeq = 0;
  private playAcked = false;
  private yaw = 0;
  private notice = "";
  private denied = false;
  private ending = "";
  private echoUntil = 0;
  private pendingPause = false;
  private pauseSeq = 0;
  private chatting = false;
  private chatLocked = false;
  private chatId = Math.floor(Date.now() / 1000);
  private chatSending = false;
  private chatSeed = "";
  private chatNote = "";
  private noticeUntil = 0;

  constructor(private readonly sink: ControlSink, private readonly now: () => number = () => performance.now()) {
    this.machine = new ControlMachine({
      requestLock: () => sink.lock(),
      exitLock: () => sink.unlock(),
      changed: (mode, previous) => {
        this.chatting = false;
        this.input.setUi(this.machine.ui, this.now());
        this.settle = Infinity;
        this.playSeq = 0;
        this.playAcked = false;
        const sameGrant = this.info?.grant === this.machine.grant;
        if (sameGrant && previous === "play" && (mode === "pause" || mode === "idle")) {
          this.pendingPause = true;
          this.pauseSeq = 0;
        } else if (mode === "inventory" || mode === "view") this.pendingPause = false;
        if (mode === "play" || (previous === "inventory" && mode === "idle")) this.notice = "";
        if (sameGrant && previous === "inventory" && (mode === "idle" || mode === "play") && !this.following) this.queued.push(this.inventory ? [KIND.close, this.inventory.menu] : [KIND.close]);
        this.render();
      },
    });
  }

  get mode(): Mode {
    return this.machine.mode;
  }

  private get inventory(): InventorySnapshot | null {
    return this.info?.inventory ?? null;
  }

  private clickPending(): boolean {
    return this.shot?.args[0] === KIND.click || this.queued.some(entry => entry[0] === KIND.click);
  }

  private render(): void {
    const info = this.info;
    this.sink.state({
      mode: this.machine.mode,
      label: this.machine.label,
      canReturn: !!info && canHandBack(info.canReturn, this.inventory, this.clickPending()),
      canPlay: info?.canPlay !== false,
      canResume: !!info?.canResume && info.checkpoint === "parked",
      canRestart: !!info?.canRestart && info.checkpoint === "parked",
      checkpoint: info?.checkpoint ?? "none",
      notice: this.notice,
      denied: this.denied,
      chatOpen: this.chatting,
      chatSeed: this.chatSeed,
      chatNote: this.chatNote,
    });
  }

  reset(notice = ""): void {
    this.notice = notice;
    this.info = null;
    this.queued = [];
    this.shot = null;
    this.sequence = 0;
    this.settle = 0;
    this.denied = false;
    this.pendingPause = false;
    this.pauseSeq = 0;
    this.chatting = false;
    this.machine.setGrant(null);
    this.sink.inventory(null);
    this.sink.marker(null);
    this.render();
  }

  apply(batch: TerrainBatch): void {
    if (batch.status !== "ready") {
      if (this.machine.grant !== null) this.reset();
      return;
    }
    this.yaw = batch.yaw;
    const control = batch.control;
    if (control === undefined) return;
    if (control === null) {
      if (this.machine.grant === null) return;
      this.reset(this.ending || "Control ended.");
      this.ending = "";
      return;
    }
    if (control.grant !== this.machine.grant) {
      this.queued = [];
      this.shot = null;
      this.sequence = 0;
      this.settle = 0;
      this.notice = "";
      this.denied = false;
      this.pendingPause = false;
      this.pauseSeq = 0;
      this.machine.setGrant(control.grant);
      this.settle = 0;
    }
    this.info = control;
    if (this.machine.mode === "inventory" && this.closable()) this.notice = "";
    if (this.shot && control.ack >= this.shot.seq) this.shot = null;
    if (this.pauseSeq && control.ack >= this.pauseSeq) {
      this.pendingPause = false;
      this.pauseSeq = 0;
    }
    if (this.playSeq && control.ack >= this.playSeq && control.mode === "play") this.playAcked = true;
    if (control.ack >= this.settle) {
      this.following = true;
      this.machine.follow(control.mode);
      this.following = false;
    }
    if (control.marker !== undefined) this.sink.marker(control.marker);
    this.sink.inventory(this.machine.mode === "inventory" ? this.inventory : null);
    this.render();
  }

  outbound(): Record<string, unknown> | null {
    const grant = this.machine.grant;
    if (grant === null) return null;
    const now = this.now();
    if (this.shot && now - this.shot.sentAt > ONE_SHOT_TIMEOUT_MS) this.shot = null;
    if (!this.shot && this.queued.length) {
      const args = this.queued.shift()!;
      this.shot = { seq: ++this.sequence, args, sentAt: now };
    }
    if (this.shot) return { i: [grant, this.shot.seq, ...this.shot.args] };
    const seq = ++this.sequence;
    const mode = this.machine.mode;
    if (this.noticeUntil && now >= this.noticeUntil) {
      this.noticeUntil = 0;
      this.notice = "";
      this.render();
    }
    if (mode === "play" && this.chatting && this.playAcked) return { i: [grant, seq, KIND.chat] };
    if (mode === "play" && this.pendingPause) {
      this.pauseSeq ||= seq;
      return { i: [grant, seq, KIND.pause] };
    }
    if (this.settle === Infinity) this.settle = seq;
    if (mode === "pause" && this.pendingPause) this.pauseSeq ||= seq;
    if (mode === "play") {
      const frame = this.input.frame(now);
      if (!this.playAcked) {
        if (frame.iceToggle) this.input.requeueIce();
        this.playSeq ||= seq;
        return { i: [grant, seq, KIND.play, 0, 0, 0, 0, -1] };
      }
      if (frame.iceToggle) frame.taps |= 8;
      const dyaw = frame.dyaw + (frame.snap ? this.snapDelta(frame.snap) : 0);
      return { i: [grant, seq, KIND.play, frame.keys, centi(dyaw, 18000), centi(frame.dpitch, 9000), frame.taps, frame.slot ?? -1] };
    }
    return { i: [grant, seq, mode === "inventory" ? KIND.inventory : KIND.pause] };
  }

  private snapDelta(direction: -1 | 1): number {
    const heading = Math.round(this.yaw / 90) * 90;
    return wrapDegrees(heading + direction * 90 - this.yaw);
  }

  private enqueue(...args: number[]): void {
    this.queued.push(args);
    this.render();
  }

  intervene(): void {
    if (this.machine.grant === null || this.info?.canPlay === false) return;
    if (this.machine.mode === "idle" && this.machine.markIntervened()) this.enqueue(KIND.intervene);
    this.machine.capture();
  }

  resumePlay(): void {
    if (this.info?.canPlay === false) return;
    this.machine.capture();
  }

  playWithoutCapture(): void {
    if (this.machine.grant === null || this.info?.canPlay === false) return;
    if (this.machine.markIntervened()) this.enqueue(KIND.intervene);
    this.machine.playUnlocked();
  }

  lockChanged(locked: boolean): void {
    if (locked) this.denied = false;
    const playing = this.machine.mode === "play";
    this.machine.lockChanged(locked);
    if (!locked && playing && this.machine.mode === "pause") this.echoUntil = this.now() + ESCAPE_ECHO_MS;
  }

  lockDenied(): void {
    const playing = this.machine.mode === "play";
    this.machine.lockDenied();
    if (playing) return;
    this.denied = true;
    this.notice = "The browser denied mouse capture. Try again.";
    this.render();
  }

  get chatOpen(): boolean {
    return this.chatting;
  }

  openChat(seed = ""): boolean {
    if (this.chatting || this.machine.grant === null || this.machine.mode !== "play" || this.info?.canPlay === false) return false;
    this.chatting = true;
    this.chatSeed = seed;
    this.chatNote = "";
    this.notice = "";
    this.input.setUi("menu", this.now());
    this.chatLocked = this.machine.suspendLock();
    this.render();
    return true;
  }

  closeChat(): void {
    if (!this.chatting) return;
    this.chatting = false;
    this.chatSeed = this.chatNote = "";
    this.input.setUi(this.machine.ui, this.now());
    if (this.chatLocked) this.machine.resumeLock();
    this.chatLocked = false;
    this.render();
  }

  submitChat(raw: string): string {
    const message = outgoing(raw);
    if (!message.ok) {
      if (message.reason === "") this.closeChat();
      return this.setChatNote(message.reason);
    }
    const grant = this.machine.grant;
    if (!this.chatting || grant === null || !this.sink.say) return this.setChatNote("Chat is unavailable.");
    if (this.info?.chatSupported === false) return this.setChatNote("This viewer build cannot send chat.");
    if (!this.info?.canChat) return this.setChatNote("Chat is still opening. Press Enter again.");
    if (this.chatSending) return this.setChatNote("Wait for the previous message to send.");
    this.chatSending = true;
    this.chatId = Math.min(this.chatId + 1, 0xFFFFFFFF);
    const command = message.text.startsWith("/");
    this.sink.say(grant, this.chatId, message.text).then(
      result => this.chatSent(grant, result, command),
      () => this.chatSent(grant, "failed", command),
    );
    return this.setChatNote(command ? "Sending command\u2026" : "Sending\u2026");
  }

  private setChatNote(note: string): string {
    this.chatNote = note;
    if (this.chatting) this.render();
    return note;
  }

  private chatSent(grant: number, result: "sent" | "rejected" | "limited" | "failed", command: boolean): void {
    this.chatSending = false;
    if (this.machine.grant !== grant) return;
    if (result === "sent") {
      this.closeChat();
      return;
    }
    const what = command ? "Command" : "Message";
    const note = result === "limited" ? `${what} not sent: slow down and try again.`
      : result === "failed" ? `${what} may not have been delivered and was not retried. Check chat before sending again.`
      : `${what} not sent: chat is unavailable or the server connection changed.`;
    if (this.chatting) {
      this.setChatNote(note);
      return;
    }
    this.notice = note;
    this.noticeUntil = this.now() + CHAT_NOTICE_MS;
    this.render();
  }

  captureOnClick(): boolean {
    if (this.chatting) return true;
    if (!this.machine.captureOnClick) return false;
    this.machine.capture();
    return true;
  }

  returnToScript(): void {
    const info = this.info;
    if (!info || !canHandBack(info.canReturn, this.inventory, this.clickPending())) return;
    this.ending = "Control returned to the script.";
    this.enqueue(KIND.ret);
  }

  resumeScript(): void {
    if (this.info?.canResume && this.info.checkpoint === "parked") this.enqueue(KIND.resume);
  }

  restartScript(): void {
    if (this.info?.canRestart && this.info.checkpoint === "parked") this.enqueue(KIND.restart);
  }

  keyDown(code: string, repeat: boolean): boolean {
    if (this.machine.grant === null) return false;
    if (this.chatting) return true;
    if (code === "KeyT" && !repeat && this.openChat()) return true;
    if (code === "Escape" && repeat) return true;
    if (this.machine.mode === "inventory" && (code === "Escape" || code === "KeyE")) {
      if (!repeat) this.closeInventory();
      return true;
    }
    if (code === "Escape" && this.machine.mode === "pause") {
      if (this.now() >= this.echoUntil && this.info?.canPlay !== false) this.machine.key(code);
      return true;
    }
    if (!repeat && this.machine.key(code)) return true;
    if (this.machine.mode !== "play") return false;
    this.input.keyDown(code, this.now(), repeat);
    return true;
  }

  private closeInventory(): void {
    if (this.closable()) {
      this.machine.key("KeyE");
      return;
    }
    this.notice = "Your last inventory action is still being sent. Try closing again in a moment.";
    this.render();
  }

  private closable(): boolean {
    const inv = this.inventory;
    return !this.clickPending() && (!inv || !inv.pending);
  }

  keyUp(code: string): void {
    if (code === "Escape") this.echoUntil = 0;
    this.input.keyUp(code, this.now());
  }

  mouseDown(button: number): void {
    this.input.mouseDown(button, this.now());
  }

  mouseUp(button: number): void {
    this.input.mouseUp(button, this.now());
  }

  mouseMove(dx: number, dy: number): void {
    this.input.mouseMove(dx, dy, this.now());
  }

  touchKeys(bits: number): void {
    if (this.machine.mode === "play") this.input.touchKeys(bits, this.now());
  }

  touchAbort(bits: number): void {
    this.input.touchAbort(bits);
  }

  touchLook(dx: number, dy: number): void {
    if (this.machine.mode === "play") this.input.touchLook(dx, dy, this.now());
  }

  touchSlot(index: number): void {
    if (this.machine.mode === "play" && index >= 0 && index < 9) this.input.keyDown(`Digit${index + 1}`, this.now());
  }

  focusLost(): void {
    this.input.clear(this.now());
    this.machine.focusLost();
  }

  inventoryClick(op: ClickOp, slot: number, button: number): void {
    const inv = this.inventory;
    if (this.machine.mode !== "inventory" || !inv || this.clickPending()) return;
    const click = buildClick(inv, op, slot, button);
    if (click) this.enqueue(KIND.click, click.menu, click.revision, click.slot, click.op, click.button);
  }
}
