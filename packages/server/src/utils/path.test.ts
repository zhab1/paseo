import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import {
  areEquivalentPaths,
  createPathEquivalenceMatcher,
  createRealpathAwarePathResolver,
  getRealpathAwareRelativePath,
  isPathInsideRoot,
} from "./path.js";

describe("path equivalence", () => {
  test("a metadata batch resolves paths once instead of once per workspace comparison", () => {
    const native = vi.spyOn(realpathSync, "native");
    try {
      const { relativePath } = createRealpathAwarePathResolver();
      for (let workspace = 0; workspace < 8; workspace++) {
        for (let event = 0; event < 64; event++) {
          relativePath(
            `/paseo-test/repo/.git/worktrees/w${workspace}`,
            `/paseo-test/repo/.git/refs/heads/b${event}`,
          );
        }
      }
      expect(native).toHaveBeenCalledTimes(8 + 64);
    } finally {
      native.mockRestore();
    }
  });

  test.each([
    ["C:/Users/Administrator/GhostFactory", "C:\\Users\\Administrator\\GhostFactory"],
    ["d:\\Projects\\paseo", "D:\\Projects\\paseo"],
    ["C:\\Users\\Administrator\\GhostFactory\\", "C:\\Users\\Administrator\\GhostFactory"],
    [String.raw`\\?\C:\Users\Administrator\GhostFactory`, "C:\\Users\\Administrator\\GhostFactory"],
    [String.raw`\\?\UNC\server\share\GhostFactory`, String.raw`\\server\share\GhostFactory`],
  ])("matches Windows-equivalent cwd forms", (left, right) => {
    expect(areEquivalentPaths(left, right)).toBe(true);
    expect(createPathEquivalenceMatcher(left)(right)).toBe(true);
  });

  test("keeps POSIX path casing significant", () => {
    expect(
      areEquivalentPaths("/Users/Administrator/GhostFactory", "/users/administrator/ghostfactory"),
    ).toBe(false);
  });

  test("checks POSIX root containment without prefix false positives", () => {
    expect(isPathInsideRoot("/opt/paseo", "/opt/paseo/node_modules/@getpaseo/server")).toBe(true);
    expect(isPathInsideRoot("/opt/paseo", "/opt/paseo-other")).toBe(false);
  });

  test("checks Windows root containment case-insensitively", () => {
    expect(
      isPathInsideRoot("C:\\Paseo\\node_modules", "c:/paseo/node_modules/@getpaseo/server"),
    ).toBe(true);
    expect(isPathInsideRoot("C:\\Paseo\\node_modules", "C:\\Paseo\\node_modules-other")).toBe(
      false,
    );
  });

  test("preserves the casing of Windows relative suffixes", () => {
    expect(getRealpathAwareRelativePath("C:\\Repo\\.git", "c:\\repo\\.git\\HEAD")).toBe("HEAD");
    expect(
      getRealpathAwareRelativePath("C:\\Repo\\.git", "c:\\repo\\.git\\refs\\heads\\FeatureCase"),
    ).toBe("refs\\heads\\FeatureCase");
  });

  test.skipIf(process.platform === "win32")(
    "derives the contained suffix from a realpath-equivalent root",
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), "paseo-path-"));
      try {
        const realRoot = join(tempDir, "real-root");
        const nestedPath = join(realRoot, "packages", "app");
        const aliasRoot = join(tempDir, "root-alias");
        mkdirSync(nestedPath, { recursive: true });
        symlinkSync(realRoot, aliasRoot, "dir");
        const nestedAlias = join(realRoot, "alias");
        symlinkSync(realRoot, nestedAlias, "dir");
        const resolver = createRealpathAwarePathResolver();
        expect(resolver.matches(realRoot, nestedAlias)).toBe(true);
        expect(resolver.relativePath(realRoot, nestedAlias)).toBe("alias");

        expect(getRealpathAwareRelativePath(aliasRoot, nestedPath)).toBe(join("packages", "app"));
        expect(getRealpathAwareRelativePath(aliasRoot, tempDir)).toBeNull();
        const { relativePath: batch } = createRealpathAwarePathResolver();
        expect(batch(aliasRoot, nestedPath)).toBe(join("packages", "app"));
        expect(batch(aliasRoot, tempDir)).toBeNull();
        unlinkSync(aliasRoot);
        symlinkSync(tempDir, aliasRoot, "dir");
        // A new callback must observe a changed link instead of retaining the prior resolution.
        const { relativePath: nextBatch } = createRealpathAwarePathResolver();
        expect(nextBatch(aliasRoot, nestedPath)).toBe(join("real-root", "packages", "app"));
        expect(nextBatch(aliasRoot, tempDir)).toBe("");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});
