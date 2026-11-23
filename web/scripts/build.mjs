import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, fromSource, root } from "./compile.mjs";

const dist = join(root, "dist");
const outputs = new Map();
const rendererModules = ["camera", "terrain", "renderer"];

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

for (const name of rendererModules) outputs.set(`${name}.js`, compile(name));
for (const name of ["fixture.html", "index.html", "viewer.css"]) outputs.set(name, fromSource(name));
outputs.set("fixture-bundle.js", bundle("fixture", []));
outputs.set("viewer-bundle.js", bundle("viewer", ["wire", "feed", "viewer-terrain", "viewer-hud"]));

if (process.argv.includes("--check")) {
  const names = readdirSync(dist).sort();
  const expected = [...outputs.keys()].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("Unexpected paths in dist; rebuild frontend");
  for (const [name, contents] of outputs) {
    if (readFileSync(join(dist, name), "utf8") !== contents) throw new Error(`Stale dist/${name}; rebuild frontend`);
  }
} else {
  mkdirSync(dist, { recursive: true });
  for (const [name, contents] of outputs) writeFileSync(join(dist, name), contents);
}
