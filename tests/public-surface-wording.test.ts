import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Files that reach readers (the npm tarball, the README files and the changelog) must not
// point at the private development notes this package was built from: links into the
// private repository, internal task, milestone and review labels, month-level stage names,
// the row numbers of the review table, design decision numbers, or section numbers of
// unpublished documents. dist is generated from src, so src is what is checked.

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Internal references in the wording of the published files.
 *
 * Each alternative is kept narrow on purpose, so ordinary code and text (EPSG codes,
 * `UTJCP:ZONE-B`, `metresPerUnit`, `UTF-8`, `ISO-8601`, `x-skew`) stay clean. The samples
 * used by the tests below are the guard that the expression is neither too narrow nor too
 * wide.
 */
const INTERNAL_REFERENCE =
  /docs\/superpowers|\bm[0-9]+[ab]?-t[0-9]+|\bCycle ?[0-9]|post-cycle|仮仕様|AC-m[0-9]|HR-m[0-9]|SR-m[0-9]|maplat-v4-crs-libs|provisional specification|§[0-9]|\b(?:dec|nov|oct)2[0-9]|\b[A-Z]-[0-9]+\b|\bDM-[A-Z]?[0-9]|\bK[0-9]+\b|設計|rule-00|那由多|INF-[0-9]|\bAC-?[0-9]/;

/**
 * Lines the expression must flag. The labels are made up (they follow the shapes of the
 * real ones without naming any), so this file does not carry internal references itself.
 */
const MUST_MATCH = [
  "dec29",
  "D-9",
  "T-99",
  "DM-Z9",
  "設計書",
  "m9-t9",
  "§9.9",
  "K99",
  "// dec29 probe",
  "// see 設計書 D-9 probe",
  "// T-99 probe",
  "// DM-Z9 probe",
];

/** Ordinary code and text the expression must leave alone. */
const MUST_NOT_MATCH = [
  "EPSG:6674",
  "UTJCP:ZONE-B",
  "metresPerUnit",
  "xScale",
  "DEFAULT_TIMEOUT_MS",
  "adapter-timeout",
  "UTF-8",
  "ISO-8601",
  "x-skew",
  "failure.reason: 'timeout'",
  "ok_with_warnings",
];

function walk(path: string): string[] {
  if (statSync(path).isDirectory()) {
    return readdirSync(path).flatMap((name) => walk(join(path, name)));
  }
  return [path];
}

function publicFiles(): string[] {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    files?: string[];
  };
  const listed = (packageJson.files ?? []).filter((entry) => entry !== "dist" && !entry.startsWith("dist/"));
  const extra = readdirSync(packageRoot).filter((name) => /^README.*\.md$/.test(name) || name === "CHANGELOG.md");
  const files = new Set<string>();
  for (const entry of [...listed, ...extra]) {
    for (const file of walk(join(packageRoot, entry))) files.add(file);
  }
  return [...files].sort();
}

describe("public files carry no internal references", () => {
  const files = publicFiles();

  it("scans at least one file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("flags the internal references reviewers reported", () => {
    for (const sample of MUST_MATCH) {
      expect(INTERNAL_REFERENCE.test(sample), sample).toBe(true);
    }
  });

  it("leaves ordinary code and text alone", () => {
    for (const sample of MUST_NOT_MATCH) {
      expect(INTERNAL_REFERENCE.test(sample), sample).toBe(false);
    }
  });

  it("has no internal reference in the published sources, README files and changelog", () => {
    const hits: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (INTERNAL_REFERENCE.test(line)) hits.push(`${relative(packageRoot, file)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
