import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, fromSource, root } from "./compile.mjs";

const dist = join(root, "dist");
const outputs = new Map();

function bundle(entry) {
  const sources = new Map();
  const pending = [entry];
  while (pending.length > 0) {
    const name = pending.shift();
    if (sources.has(name)) continue;
    const source = compile(name, true);
    sources.set(name, source);
    for (const [, path] of source.matchAll(/\brequire\("([^"]*)"\)/g)) {
      const local = /^\.\/([\w-]+)\.js$/.exec(path);
      if (!local) throw new Error(`${name}.ts requires unsupported module ${path}`);
      pending.push(local[1]);
    }
  }
  const modules = [...sources].map(([name, source]) =>
    `  "./${name}.js": (require, exports) => {\n${source}  },`);
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
outputs.set("viewer-bundle.js", bundle("viewer"));

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
