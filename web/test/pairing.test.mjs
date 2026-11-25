import assert from "node:assert/strict";
import test from "node:test";
import { load } from "../scripts/load-for-test.mjs";

const { bindPairingForm } = load("pairing");
const { ViewerFeed } = load("feed");
const storageKey = "rosegold-viewer.pairing-secret";
const secret = "ab01".repeat(16);

function pairForm(attach, invalid = assert.fail) {
  const form = new EventTarget();
  const input = { value: "" };
  const remember = Object.assign(new EventTarget(), { checked: false });
  const pairing = bindPairingForm(form, input, remember, attach, invalid);
  return {
    pairing, remember,
    submit(value) {
      input.value = value;
      form.dispatchEvent(new Event("submit", { cancelable: true }));
    },
  };
}

function fakeStorage(t) {
  const saved = new Map();
  globalThis.window = { localStorage: {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key),
  } };
  t.after(() => { delete globalThis.window; });
  return saved;
}

test("only saves a checked secret after acceptance and forgets it on uncheck", { timeout: 2000 }, async t => {
  const saved = fakeStorage(t);
  let accept;
  const accepted = new Promise(resolve => { accept = resolve; });
  const feed = new ViewerFeed({ reset() {}, apply() {}, status() {}, paired(value) {
    page.pairing.paired(value);
    accept();
  } }, async () => new Response(JSON.stringify({ lease: "aa44" })));
  t.after(() => feed.detach());
  const page = pairForm(value => feed.attach(value));
  page.pairing.restore();
  assert.equal(page.remember.checked, false);
  page.submit(secret);
  await accepted;
  feed.detach();
  assert.equal(saved.has(storageKey), false);

  let acceptAgain;
  const acceptedAgain = new Promise(resolve => { acceptAgain = resolve; });
  accept = acceptAgain;
  page.remember.checked = true;
  page.submit(` ${secret.toUpperCase()} `);
  assert.equal(saved.has(storageKey), false);
  await acceptedAgain;
  feed.detach();
  assert.equal(saved.get(storageKey), secret);
  page.remember.checked = false;
  page.remember.dispatchEvent(new Event("change"));
  assert.equal(saved.has(storageKey), false);
});

test("automatically pairs with a remembered secret and forgets it on rejection", { timeout: 2000 }, async t => {
  const saved = fakeStorage(t);
  saved.set(storageKey, secret);
  let onReject;
  const rejected = new Promise(resolve => { onReject = resolve; });
  let request;
  const feed = new ViewerFeed({ reset() {}, apply() {}, status(status) {
    if (status !== "rejected") return;
    page.pairing.rejected();
    onReject();
  } }, async (path, options) => {
    request = [path, options.headers.Authorization];
    return new Response(null, { status: 401 });
  });
  t.after(() => feed.detach());
  const page = pairForm(value => feed.attach(value));
  page.pairing.restore();
  assert.equal(page.remember.checked, true);
  await rejected;
  assert.deepEqual(request, ["/session", `Bearer ${secret}`]);
  assert.equal(saved.has(storageKey), false);
  assert.equal(page.remember.checked, false);
});

test("can pair manually with storage blocked and still validates the secret", t => {
  globalThis.window = { get localStorage() { throw new Error("Storage is blocked"); } };
  t.after(() => { delete globalThis.window; });
  const submitted = [];
  let invalid = 0;
  const page = pairForm(value => submitted.push(value), () => { invalid++; });
  page.pairing.restore();
  page.submit("invalid");
  page.remember.checked = true;
  page.submit(secret);
  page.pairing.paired(secret);
  page.pairing.rejected();
  assert.deepEqual(submitted, [secret]);
  assert.equal(invalid, 1);
  assert.equal(page.remember.checked, false);
});
