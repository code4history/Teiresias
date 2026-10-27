import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Every name exported from src/index.ts (values and types) must be documented in both
// README.md and README.ja.md. The list is read from the source at run time, so a new
// export makes this test fail until the README files mention it.
// dist/index.d.ts is generated from src/index.ts, so the two carry the same names.

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

function listExportedNames(): string[] {
  const program = ts.createProgram([entry], {
    allowImportingTsExtensions: true,
    noEmit: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`cannot read ${entry}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`${entry} is not a module`);
  return checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => symbol.getName())
    .filter((name) => name !== "default")
    .sort();
}

function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[$]/g, "\\$");
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(text);
}

describe("README documents the public API", () => {
  const names = listExportedNames();

  it("finds at least one export in src/index.ts", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const readme of ["README.md", "README.ja.md"]) {
    it(`${readme} mentions every export of src/index.ts`, () => {
      const text = readFileSync(`${packageRoot}/${readme}`, "utf8");
      const missing = names.filter((name) => !mentions(text, name));
      expect(missing).toEqual([]);
    });
  }
});
