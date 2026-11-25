import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("status meters override the stats row gap so icons stay inside their width", () => {
  const css = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");
  const rules = [...css.matchAll(/^#hud-stats \.meter \{([^}]*)\}/gm)].map(match => match[1]);
  assert.ok(rules.some(body => /(^|;)\s*gap:\s*0\s*(;|$)/.test(body)));
});
