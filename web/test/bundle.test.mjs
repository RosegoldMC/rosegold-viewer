import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";

const bundle = readFileSync(new URL("../dist/viewer-bundle.js", import.meta.url), "utf8");

test("the built viewer bundle defines every module it requires", () => {
  const defined = new Set([...bundle.matchAll(/^ {2}"(\.\/[\w-]+\.js)": \(require, exports\) => \{$/gm)].map(match => match[1]));
  const required = new Set([...bundle.matchAll(/\brequire\("([^"]*)"\)/g)].map(match => match[1]));
  assert.ok(defined.has("./viewer.js"));
  assert.deepEqual([...required].filter(name => !defined.has(name)), []);
});

test("the built viewer bundle loads its modules before touching the page", () => {
  assert.throws(() => runInThisContext(bundle), error => {
    assert.doesNotMatch(String(error?.message), /is not a function/);
    return true;
  });
});
