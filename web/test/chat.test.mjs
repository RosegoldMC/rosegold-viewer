import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runInThisContext } from "node:vm";
import { compile } from "../scripts/compile.mjs";

const modules = new Map();
function requireModule(name) {
  if (!modules.has(name)) {
    const exports = {};
    modules.set(name, exports);
    runInThisContext(`(require, exports) => {\n${compile(name.slice(2, -3), true)}\n}`)(requireModule, exports);
  }
  return modules.get(name);
}

const { ViewerChat, cleanLine, outgoing, MAX_CHAT_CHARS, MAX_CHAT_LINES } = requireModule("./chat.js");
const { ViewerFeed } = requireModule("./feed.js");
const { ViewerControl } = requireModule("./viewer-control.js");

const base = { epoch: 1, seq: 1, status: "ready", protocol: 777, yaw: 0 };
const ctl = (extra = {}) => ({ grant: 7, ack: 0, mode: "available", ...extra });

function viewerControl() {
  const log = { states: [], locks: 0, unlocks: 0 };
  let time = 0;
  const vc = new ViewerControl({
    state: view => log.states.push(view), lock: () => log.locks++, unlock: () => log.unlocks++,
    inventory() {}, marker() {},
  }, () => time);
  return { vc, log, feed: control => vc.apply({ ...base, control }), tick: ms => { time += ms; } };
}

function playing() {
  const ctx = viewerControl();
  ctx.feed(ctl());
  ctx.vc.intervene();
  ctx.vc.outbound();
  ctx.feed(ctl({ ack: 1 }));
  ctx.vc.lockChanged(true);
  ctx.feed(ctl({ ack: 1, mode: "play" }));
  ctx.vc.outbound();
  ctx.feed(ctl({ ack: 2, mode: "play" }));
  return ctx;
}

const last = log => log.states[log.states.length - 1];

test("cleanLine strips controls and bidi marks, collapses space, and caps length", () => {
  assert.equal(cleanLine("a\u0000b\u202Ec\n d\u200b"), "a b c d");
  assert.equal(cleanLine("x".repeat(1000)).length, MAX_CHAT_CHARS);
  assert.equal(cleanLine("<b onclick=x>hi</b> https://e.x"), "<b onclick=x>hi</b> https://e.x");
});

test("outgoing rejects empty text and a bare slash, accepts ordinary text and commands", () => {
  assert.deepEqual(outgoing("  \n "), { ok: false, reason: "" });
  assert.equal(outgoing(" / ").ok, false);
  assert.deepEqual(outgoing(" /list "), { ok: true, text: "/list" });
  assert.deepEqual(outgoing("//wand"), { ok: true, text: "//wand" });
  assert.deepEqual(outgoing("  hello  there "), { ok: true, text: "hello there" });
});

test("ViewerChat appends deduped bounded cleaned lines and resets on chat or feed epoch", () => {
  const shown = [];
  const chat = new ViewerChat({ show: lines => shown.push([...lines]) });
  const entries = Array.from({ length: 12 }, (_, i) => [i + 1, `m${i}`]);
  chat.apply({ ...base, chat: { epoch: 1, entries: entries.slice(0, 3) } });
  chat.apply({ ...base, seq: 2, chat: { epoch: 1, entries: entries.slice(1, 12) } });
  assert.equal(shown.at(-1).length, MAX_CHAT_LINES);
  assert.deepEqual(shown.at(-1).slice(-2), ["m10", "m11"]);
  assert.equal(shown.at(-1).filter(line => line === "m1").length <= 1, true);
  const count = shown.length;
  chat.apply({ ...base, seq: 3 });
  assert.equal(shown.length, count);
  chat.apply({ ...base, seq: 4, chat: { epoch: 2, entries: [[1, "\u0007x"]] } });
  assert.deepEqual(shown.at(-1), ["x"]);
  chat.apply({ ...base, epoch: 2, chat: { epoch: 2, entries: [[2, "y"]] } });
  assert.deepEqual(shown.at(-1), ["y"]);
  chat.apply({ epoch: 2, seq: 9, status: "waiting" });
  assert.deepEqual(shown.at(-1), []);
});

test("wire decodes chat and rejects malformed or oversized entries", () => {
  const { decodeBatch } = requireModule("./wire.js");
  const encode = data => {
    const json = new TextEncoder().encode(JSON.stringify(data));
    const out = new Uint8Array(2 + json.length);
    out.set(json, 2);
    new DataView(out.buffer).setUint16(0, json.length, true);
    return out;
  };
  assert.deepEqual(decodeBatch(encode({ ...base, chat: { epoch: 3, entries: [[1, "hi"]] } })).chat, { epoch: 3, entries: [[1, "hi"]] });
  assert.throws(() => decodeBatch(encode({ ...base, chat: { epoch: 3, entries: [[1, 5]] } })));
  assert.throws(() => decodeBatch(encode({ ...base, chat: { epoch: 3, entries: Array(17).fill([1, "a"]) } })));
  assert.throws(() => decodeBatch(encode({ ...base, chat: null })));
  assert.throws(() => decodeBatch(encode({ epoch: 1, seq: 1, status: "waiting", chat: { epoch: 1, entries: [] } })));
});

test("T in granted play opens chat: held movement is dropped and frames stay neutral", () => {
  const { vc, log, feed } = playing();
  vc.keyDown("KeyW", false);
  vc.keyDown("Space", false);
  const unlocks = log.unlocks;
  assert.equal(vc.keyDown("KeyT", false), true);
  assert.equal(vc.chatOpen, true);
  assert.equal(last(log).chatOpen, true);
  assert.equal(log.unlocks, unlocks + 1);
  assert.equal(vc.mode, "play");
  assert.deepEqual(vc.outbound().i.slice(2), [9]);
  assert.equal(vc.keyDown("KeyW", false), true);
  assert.equal(vc.keyDown("KeyW", true), true);
  assert.deepEqual(vc.outbound().i.slice(2), [9]);
  vc.lockChanged(false);
  assert.equal(vc.mode, "play");
});

test("Esc closes only chat, restores keyboard play after a neutral frame, and re-requests the pointer", () => {
  const ctx = playing();
  const { vc, log } = ctx;
  vc.keyDown("KeyW", false);
  vc.keyDown("KeyT", false);
  vc.lockChanged(false);
  vc.keyUp("KeyW");
  vc.closeChat();
  assert.equal(vc.chatOpen, false);
  assert.equal(vc.mode, "play");
  assert.equal(log.locks, 2);
  const neutral = vc.outbound().i;
  assert.deepEqual(neutral.slice(2), [1, 0, 0, 0, 0, -1]);
  ctx.feed(ctl({ ack: neutral[1], mode: "play" }));
  vc.keyDown("KeyW", true);
  assert.equal(vc.outbound().i[3], 0);
  vc.keyDown("KeyW", false);
  assert.equal(vc.outbound().i[3], 1);
  vc.lockChanged(true);
  assert.equal(vc.mode, "play");
});

test("denied pointer after chat stays in play and a canvas click recaptures", () => {
  const { vc } = playing();
  vc.keyDown("KeyT", false);
  vc.closeChat();
  vc.lockDenied();
  assert.equal(vc.mode, "play");
  assert.equal(vc.captureOnClick(), true);
});

test("keyboard-only play opens chat without touching the pointer", () => {
  const ctx = viewerControl();
  ctx.feed(ctl());
  ctx.vc.playWithoutCapture();
  const { locks, unlocks } = ctx.log;
  assert.equal(ctx.vc.mode, "play");
  assert.equal(ctx.vc.keyDown("KeyT", false), true);
  ctx.vc.closeChat();
  assert.equal(ctx.log.unlocks, unlocks);
  assert.equal(ctx.log.locks, locks);
});

test("chat cannot open outside play, without a grant, or when play is refused", () => {
  const none = viewerControl();
  assert.equal(none.vc.keyDown("KeyT", false), false);
  assert.equal(none.vc.openChat(), false);
  const idle = viewerControl();
  idle.feed(ctl());
  assert.equal(idle.vc.keyDown("KeyT", false), false);
  const refused = viewerControl();
  refused.feed(ctl({ canPlay: false }));
  assert.equal(refused.vc.openChat(), false);
});

test("chat closes when the grant ends, the host leaves play, or focus is lost", () => {
  const ended = playing();
  ended.vc.keyDown("KeyT", false);
  ended.vc.apply({ ...base, control: null });
  assert.equal(ended.vc.chatOpen, false);
  const lost = playing();
  lost.vc.keyDown("KeyT", false);
  lost.vc.focusLost();
  assert.equal(lost.vc.chatOpen, false);
  assert.equal(lost.vc.mode, "pause");
  const reset = playing();
  reset.vc.keyDown("KeyT", false);
  reset.vc.reset();
  assert.equal(reset.vc.chatOpen, false);
});

test("canvas clicks while chat is open neither capture nor act", () => {
  const { vc, log } = playing();
  vc.keyDown("KeyT", false);
  assert.equal(vc.captureOnClick(), true);
  assert.equal(log.locks, 1);
});

function sayer(result = "sent") {
  const calls = [];
  const log = { states: [], locks: 0, unlocks: 0 };
  let time = 0;
  const vc = new ViewerControl({
    state: view => log.states.push(view), lock: () => log.locks++, unlock: () => log.unlocks++, inventory() {}, marker() {},
    say: (grant, id, text) => { calls.push([grant, id, text]); return Promise.resolve(result); },
  }, () => time);
  vc.apply({ ...base, control: ctl() });
  vc.intervene();
  vc.outbound();
  vc.apply({ ...base, control: ctl({ ack: 1 }) });
  vc.lockChanged(true);
  vc.apply({ ...base, control: ctl({ ack: 1, mode: "play" }) });
  vc.outbound();
  vc.apply({ ...base, control: ctl({ ack: 2, mode: "play", canChat: true }) });
  return { vc, calls, log, tick: ms => { time += ms; } };
}

test("Enter sends ordinary text once, closes chat after the send, and resumes play frames", async () => {
  const { vc, calls } = sayer();
  vc.keyDown("KeyT", false);
  assert.equal(vc.submitChat("  hello  world "), "Sending\u2026");
  assert.equal(vc.chatOpen, true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(vc.chatOpen, false);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0][0], calls[0][2]], [7, "hello world"]);
  assert.equal(vc.submitChat("again"), "Chat is unavailable.");
  assert.equal(calls.length, 1);
  assert.equal(vc.outbound().i[2], 1);
});

test("a bare slash and empty text are never sent; a typed command is", async () => {
  const { vc, calls, log } = sayer();
  vc.keyDown("KeyT", false);
  assert.equal(vc.submitChat("/"), "Type a command after the /.");
  assert.equal(vc.chatOpen, true);
  assert.equal(vc.submitChat("   "), "");
  assert.equal(vc.chatOpen, false);
  assert.equal(calls.length, 0);
  assert.equal(vc.openChat("/"), true);
  assert.equal(last(log).chatSeed, "/");
  assert.equal(vc.submitChat("/list"), "Sending command\u2026");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], "/list");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(vc.chatOpen, false);
});

test("chat ids increase and a second send waits for the first", async () => {
  const { vc, calls } = sayer();
  vc.keyDown("KeyT", false);
  vc.submitChat("one");
  assert.equal(vc.submitChat("two"), "Wait for the previous message to send.");
  await Promise.resolve();
  await Promise.resolve();
  vc.keyDown("KeyT", false);
  assert.equal(vc.submitChat("two"), "Sending\u2026");
  assert.equal(calls[1][1], calls[0][1] + 1);
});

test("a definite failure keeps the composer open with an actionable note", async () => {
  const { vc, log } = sayer("rejected");
  vc.keyDown("KeyT", false);
  vc.submitChat("hi");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(vc.chatOpen, true);
  assert.match(last(log).chatNote, /^Message not sent/);
});

test("an unknown delivery keeps the draft and says it was not retried", async () => {
  const { vc, log, calls } = sayer("failed");
  vc.keyDown("KeyT", false);
  vc.submitChat("/list");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(vc.chatOpen, true);
  assert.match(last(log).chatNote, /^Command may not have been delivered and was not retried/);
  assert.equal(calls.length, 1);
});

test("feed posts chat once, serialized with /next, with lease auth and the feed epoch", async () => {
  const seen = [];
  let inflight = 0;
  let overlap = false;
  const status = { value: 204 };
  const feed = new ViewerFeed({ apply() {}, reset() {}, status() {} }, async (url, init) => {
    if (++inflight > 1) overlap = true;
    await delay(5);
    inflight--;
    if (url === "/session") return new Response(JSON.stringify({ lease: "ab".repeat(8) }));
    seen.push([url, init.headers.Authorization, init.body, init.credentials]);
    return new Response(null, { status: url === "/chat" ? status.value : 204 });
  });
  feed.attach("a".repeat(64));
  await delay(150);
  const result = await feed.sendChat(7, 9, "hi there");
  assert.equal(result, "sent");
  const post = seen.find(entry => entry[0] === "/chat");
  assert.equal(post[1], `Bearer ${"ab".repeat(8)}`);
  assert.deepEqual(JSON.parse(post[2]), { epoch: 0, grant: 7, id: 9, text: "hi there" });
  assert.equal(post[3], "omit");
  status.value = 409;
  assert.equal(await feed.sendChat(7, 10, "x"), "rejected");
  status.value = 429;
  assert.equal(await feed.sendChat(7, 11, "x"), "limited");
  status.value = 502;
  assert.equal(await feed.sendChat(7, 12, "x"), "failed");
  status.value = 504;
  assert.equal(await feed.sendChat(7, 14, "x"), "failed");
  feed.detach();
  assert.equal(await feed.sendChat(7, 13, "x"), "failed");
  assert.equal(overlap, false);
});

test("send waits for the host to accept chat focus and rejects over-long text", () => {
  const { vc, calls } = sayer();
  vc.apply({ ...base, control: ctl({ ack: 3, mode: "play" }) });
  vc.keyDown("KeyT", false);
  assert.equal(vc.submitChat("hi"), "Chat is still opening. Press Enter again.");
  assert.equal(vc.chatOpen, true);
  vc.apply({ ...base, control: ctl({ ack: 4, mode: "play", canChat: true }) });
  assert.equal(vc.submitChat("é".repeat(129)), "Message is too long.");
  assert.equal(calls.length, 0);
  assert.equal(vc.submitChat("é".repeat(128)), "Sending\u2026");
  assert.equal(calls.length, 1);
});

test("chat focus waits for the first native play ack, sending neutral play frames meanwhile", () => {
  const ctx = viewerControl();
  ctx.feed(ctl());
  ctx.vc.intervene();
  ctx.vc.outbound();
  ctx.feed(ctl({ ack: 1 }));
  ctx.vc.lockChanged(true);
  ctx.feed(ctl({ ack: 1, mode: "play" }));
  assert.equal(ctx.vc.openChat(), true);
  assert.equal(ctx.vc.outbound().i[2], 1);
  ctx.feed(ctl({ ack: 2, mode: "play" }));
  assert.equal(ctx.vc.outbound().i[2], 9);
});

test("immediate T and early Enter before the play ack keep the draft, then send after chat focus is acked", async () => {
  const calls = [];
  let time = 0;
  const vc = new ViewerControl({
    state() {}, lock() {}, unlock() {}, inventory() {}, marker() {},
    say: (grant, id, text) => { calls.push(text); return Promise.resolve("sent"); },
  }, () => time);
  vc.apply({ ...base, control: ctl() });
  vc.intervene();
  vc.outbound();
  vc.apply({ ...base, control: ctl({ ack: 1 }) });
  vc.lockChanged(true);
  vc.apply({ ...base, control: ctl({ ack: 1, mode: "play" }) });
  assert.equal(vc.openChat(), true);
  assert.equal(vc.submitChat("early"), "Chat is still opening. Press Enter again.");
  assert.equal(vc.outbound().i[2], 1);
  vc.apply({ ...base, control: ctl({ ack: 2, mode: "play" }) });
  assert.equal(vc.outbound().i[2], 9);
  assert.equal(vc.submitChat("early"), "Chat is still opening. Press Enter again.");
  vc.apply({ ...base, control: ctl({ ack: 3, mode: "play", canChat: true }) });
  assert.equal(vc.submitChat("early"), "Sending\u2026");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["early"]);
});
