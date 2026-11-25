import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const root = fileURLToPath(new URL("../", import.meta.url));
const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);

export function fromSource(name) {
  return readFileSync(join(root, "src", name), "utf8").replace(/\r\n/g, "\n");
}

export function compile(name, commonJS = false) {
  const module = commonJS ? ts.ModuleKind.CommonJS : ts.ModuleKind.ES2022;
  return ts.transpileModule(fromSource(`${name}.ts`), {
    fileName: `${name}.ts`,
    compilerOptions: { ...options, module, moduleResolution: undefined, noEmit: false, newLine: ts.NewLineKind.LineFeed },
  }).outputText;
}
