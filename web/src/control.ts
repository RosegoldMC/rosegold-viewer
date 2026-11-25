import type { Ui } from "./input.js";

export type Mode = "view" | "idle" | "play" | "pause" | "inventory";

interface ControlEnv {
  requestLock(): void;
  exitLock(): void;
  changed(mode: Mode, previous: Mode): void;
}

export class ControlMachine {
  mode: Mode = "view";
  grant: number | null = null;
  intervened = false;
  private awaitingLock = false;
  private resumed = false;
  private locked = false;
  private returnTo: "locked" | "keyboard" | null = null;
  private pausedFrom: "locked" | "keyboard" = "keyboard";
  private recapturable = false;
  private clickCapture = false;

  constructor(private readonly env: ControlEnv) {}

  get ui(): Ui {
    return this.mode === "play" ? "play" : this.mode === "inventory" ? "inventory" : "menu";
  }

  get captureOnClick(): boolean {
    return this.mode === "play" && this.recapturable && !this.locked;
  }

  get label(): string {
    return this.resumed ? "Resume play" : "Intervene";
  }

  private set(mode: Mode): void {
    if (mode === this.mode) return;
    const previous = this.mode;
    if (mode === "inventory") {
      if (previous === "play") this.returnTo = this.locked ? "locked" : "keyboard";
      else this.returnTo = null;
    }
    if (mode !== "play") this.recapturable = false;
    this.mode = mode;
    this.env.changed(mode, previous);
  }

  private release(mode: Mode): void {
    if (mode === "pause" && this.mode === "play") this.pausedFrom = this.locked ? "locked" : "keyboard";
    this.awaitingLock = false;
    this.set(mode);
    this.locked = false;
    this.env.exitLock();
  }

  closeInventory(): void {
    const back = this.returnTo;
    this.returnTo = null;
    if (this.grant === null || this.mode !== "inventory") return;
    if (!back) {
      this.release("idle");
      return;
    }
    this.resumePlay(back);
  }

  private resumePlay(back: "locked" | "keyboard"): void {
    this.awaitingLock = back === "locked";
    this.resumed = true;
    this.set("play");
    if (back === "locked") {
      this.recapturable = true;
      this.env.requestLock();
    }
  }

  setGrant(grant: number | null): void {
    if (grant === this.grant) return;
    this.grant = grant;
    this.returnTo = null;
    this.resumed = false;
    this.intervened = false;
    if (grant === null) this.release("view");
    else this.release("idle");
  }

  capture(): void {
    if (this.grant === null || this.mode === "view") return;
    if (this.mode === "play" && (this.locked || !this.recapturable)) return;
    this.clickCapture = this.mode === "play";
    this.awaitingLock = true;
    this.env.requestLock();
  }

  lockChanged(locked: boolean): void {
    if (this.grant === null) {
      if (locked) this.env.exitLock();
      return;
    }
    if (locked) {
      if (!this.awaitingLock && this.mode !== "play") {
        this.env.exitLock();
        return;
      }
      this.awaitingLock = false;
      this.clickCapture = false;
      this.locked = true;
      this.recapturable = false;
      if (this.mode === "play") return;
      this.resumed = true;
      this.set("play");
    } else {
      const was = this.locked;
      this.locked = false;
      if (was && this.mode === "play") {
        this.pausedFrom = "locked";
        this.set("pause");
      }
    }
  }

  markIntervened(): boolean {
    if (this.intervened) return false;
    this.intervened = true;
    return true;
  }

  playUnlocked(): void {
    if (this.grant === null || (this.mode !== "idle" && this.mode !== "pause")) return;
    this.awaitingLock = false;
    this.resumed = true;
    this.set("play");
  }

  lockDenied(): void {
    this.awaitingLock = false;
    if (this.clickCapture) this.recapturable = false;
    this.clickCapture = false;
  }

  key(code: string): boolean {
    if (this.grant === null) return false;
    if (code === "Escape") {
      if (this.mode === "play") this.release("pause");
      else if (this.mode === "inventory") this.closeInventory();
      else if (this.mode === "pause") this.resumePlay(this.pausedFrom);
      return true;
    }
    if (code === "KeyE") {
      if (this.mode === "play" || this.mode === "pause") this.release("inventory");
      else if (this.mode === "inventory") this.closeInventory();
      else return false;
      return true;
    }
    return false;
  }

  follow(host: "available" | "play" | "pause" | "inventory"): void {
    if (this.grant === null) return;
    if (host === "inventory") {
      if (this.mode !== "inventory") this.release("inventory");
    } else if (this.mode === "inventory") {
      const back = this.returnTo;
      this.returnTo = null;
      if (back) this.resumePlay(back);
      else this.release("idle");
    } else if (host !== "play" && this.mode === "play") {
      this.release("pause");
    }
  }

  suspendLock(): boolean {
    if (this.grant === null || this.mode !== "play") return false;
    const was = this.locked;
    this.locked = false;
    this.awaitingLock = false;
    this.recapturable = was;
    if (was) this.env.exitLock();
    return was;
  }

  resumeLock(): void {
    if (this.grant === null || this.mode !== "play" || this.locked) return;
    this.awaitingLock = true;
    this.recapturable = true;
    this.env.requestLock();
  }

  focusLost(): void {
    this.awaitingLock = false;
    this.clickCapture = false;
    if (this.mode === "play") this.release("pause");
  }
}
