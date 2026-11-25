import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, fromSource, root } from "./compile.mjs";

const dist = join(root, "dist");
const outputs = new Map();
const rendererModules = ["camera", "liquid", "terrain", "atlas", "block-models", "entity-geometry", "entity-skin", "entity-state", "entity-layer", "entity-glue", "renderer"];

function bundle(entry, others) {
  const modules = [...rendererModules, ...others, entry].map(name =>
    `  "./${name}.js": (require, exports) => {\n${compile(name, true)}  },`);
  return `(() => {
const modules = {
${modules.join("\n")}
};
const loaded = new Map();
function require(name) {
  if (!loaded.has(name)) {
    const exports = {};
    loaded.set(name, exports);
    modules[name](require, exports);
  }
  return loaded.get(name);
}
require("./${entry}.js");
})();
`;
}

for (const name of ["index.html", "viewer.css"]) outputs.set(name, fromSource(name));
outputs.set("viewer-bundle.js", bundle("viewer", ["wire", "feed", "input", "touch", "control", "inventory", "viewer-terrain", "viewer-hud", "chat", "debug-format", "viewer-debug", "viewer-inventory", "viewer-control"]));

const check = process.argv.includes("--check");
if (!check) mkdirSync(dist, { recursive: true });
for (const entry of readdirSync(dist, { withFileTypes: true })) {
  if (!entry.isFile() || !outputs.has(entry.name)) throw new Error(`Unexpected path in dist: ${entry.name}`);
}
if (check) {
  for (const [name, contents] of outputs) {
    if (readFileSync(join(dist, name), "utf8") !== contents) throw new Error(`Stale dist/${name}; rebuild frontend`);
  }
} else {
  for (const [name, contents] of outputs) writeFileSync(join(dist, name), contents);
}
