import { runInThisContext } from "node:vm";
import { compile } from "./compile.mjs";

const modules = new Map();

export function load(name) {
  if (modules.has(name)) return modules.get(name);
  const exports = {};
  modules.set(name, exports);
  const evaluate = runInThisContext(`(function (require, exports) {\n${compile(name, true)}\n})`, { filename: `${name}.ts` });
  evaluate(path => load(path.slice(2, -3)), exports);
  return exports;
}
