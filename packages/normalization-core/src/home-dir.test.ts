import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEffectiveHomeDir } from "./home-dir.js";

describe("resolveEffectiveHomeDir", () => {
  it("preserves terminal display fallback for unresolved tilde homes", () => {
    const env = { OPENCLAW_HOME: "~" } as NodeJS.ProcessEnv;
    const unavailableHome = () => {
      throw new Error("missing home");
    };

    expect(resolveEffectiveHomeDir(env, unavailableHome)).toBeUndefined();
    expect(resolveEffectiveHomeDir(env, unavailableHome, { preserveUnresolvedTilde: true })).toBe(
      path.resolve("~"),
    );
  });
});
