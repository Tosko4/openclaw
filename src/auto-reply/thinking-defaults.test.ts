/** Tests thinking labels, defaults, reasoning, and usage normalization. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerRuntimeMocks = vi.hoisted(() => ({
  resolveProviderThinkingProfile: vi.fn(),
}));

vi.mock("../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: providerRuntimeMocks.resolveProviderThinkingProfile,
}));

const {
  listThinkingLevelLabels,
  normalizeReasoningLevel,
  resolveThinkingDefaultForModel,
  resolveEffectiveResponseUsage,
} = await import("./thinking.js");

beforeEach(() => {
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReset();
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue(undefined);
});

describe("listThinkingLevelLabels", () => {
  it("uses provider thinking profiles for binary thinking providers", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
    });

    expect(listThinkingLevelLabels("demo", "demo-model")).toEqual(["off", "on"]);
  });

  it("returns on/off for provider-advertised binary thinking", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ provider }) =>
      provider === "zai"
        ? {
            levels: [
              { id: "off", label: "off" },
              { id: "low", label: "on" },
            ],
          }
        : undefined,
    );

    expect(listThinkingLevelLabels("zai", "glm-4.7")).toEqual(["off", "on"]);
  });

  it("does not assume binary thinking without provider runtime", () => {
    expect(listThinkingLevelLabels("zai", "glm-4.7")).toContain("low");
    expect(listThinkingLevelLabels("zai", "glm-4.7")).not.toContain("on");
  });

  it("returns full levels for non-ZAI", () => {
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).toContain("low");
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).not.toContain("on");
  });
});

describe("resolveThinkingDefaultForModel", () => {
  it("uses provider thinking profiles for default thinking levels", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "adaptive" }],
      defaultLevel: "adaptive",
    });

    expect(resolveThinkingDefaultForModel({ provider: "demo", model: "demo-model" })).toBe(
      "adaptive",
    );
  });

  it("uses provider-advertised adaptive defaults", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(
      ({ provider, context }) =>
        provider === "anthropic" && context.modelId === "claude-opus-4-6"
          ? { levels: [{ id: "off" }, { id: "adaptive" }], defaultLevel: "adaptive" }
          : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({ provider: "anthropic", model: "claude-opus-4-6" }),
    ).toBe("adaptive");
  });

  it("does not apply provider-advertised adaptive defaults across Bedrock id variants", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(
      ({ provider, context }) =>
        provider === "amazon-bedrock" && context.modelId === "claude-sonnet-4-6"
          ? { levels: [{ id: "off" }, { id: "adaptive" }], defaultLevel: "adaptive" }
          : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({ provider: "aws-bedrock", model: "claude-sonnet-4-6" }),
    ).toBe("off");
  });

  it("does not assume adaptive defaults without provider runtime", () => {
    expect(
      resolveThinkingDefaultForModel({ provider: "anthropic", model: "claude-opus-4-6" }),
    ).toBe("off");
    expect(
      resolveThinkingDefaultForModel({ provider: "aws-bedrock", model: "claude-sonnet-4-6" }),
    ).toBe("off");
  });

  it("defaults reasoning-capable catalog models to medium", () => {
    expect(
      resolveThinkingDefaultForModel({
        provider: "openai",
        model: "gpt-5.4",
        catalog: [{ provider: "openai", id: "gpt-5.4", reasoning: true }],
      }),
    ).toBe("medium");
  });

  it("remaps implicit reasoning defaults to the strongest supported level at or below medium", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ provider }) =>
      provider === "demo-binary" ? { levels: [{ id: "off" }, { id: "low" }] } : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({
        provider: "demo-binary",
        model: "demo-model",
        catalog: [{ provider: "demo-binary", id: "demo-model", reasoning: true }],
      }),
    ).toBe("low");
  });

  it("keeps catalog reasoning context when remapping implicit reasoning defaults", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(
      ({ provider, context }) =>
        provider === "demo-contextual" && context.reasoning
          ? { levels: [{ id: "off" }, { id: "low" }, { id: "medium" }] }
          : provider === "demo-contextual"
            ? { levels: [{ id: "off" }] }
            : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({
        provider: "demo-contextual",
        model: "demo-model",
        catalog: [{ provider: "demo-contextual", id: "demo-model", reasoning: true }],
      }),
    ).toBe("medium");
  });

  it("defaults to off when no adaptive or reasoning hint is present", () => {
    expect(
      resolveThinkingDefaultForModel({
        provider: "openai",
        model: "gpt-4.1-mini",
        catalog: [{ provider: "openai", id: "gpt-4.1-mini", reasoning: false }],
      }),
    ).toBe("off");
  });

  it("respects provider-declared 'off' default for reasoning-capable models", () => {
    // Providers like Ollama declare defaultLevel:"off" even for reasoning=true models
    // because thinking must be explicitly opted in, not activated by the global default.
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ provider }) =>
      provider === "ollama"
        ? {
            levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
            defaultLevel: "off",
          }
        : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({
        provider: "ollama",
        model: "gemma4",
        catalog: [{ provider: "ollama", id: "gemma4", reasoning: true }],
      }),
    ).toBe("off");
  });
});

describe("normalizeReasoningLevel", () => {
  it("accepts on/off", () => {
    expect(normalizeReasoningLevel("on")).toBe("on");
    expect(normalizeReasoningLevel("off")).toBe("off");
  });

  it("accepts show/hide", () => {
    expect(normalizeReasoningLevel("show")).toBe("on");
    expect(normalizeReasoningLevel("hide")).toBe("off");
  });

  it("accepts stream", () => {
    expect(normalizeReasoningLevel("stream")).toBe("stream");
    expect(normalizeReasoningLevel("streaming")).toBe("stream");
  });
});

describe("resolveEffectiveResponseUsage", () => {
  it("returns off when session is unset and no config is provided", () => {
    expect(resolveEffectiveResponseUsage(undefined, undefined)).toBe("off");
    expect(resolveEffectiveResponseUsage(null, undefined)).toBe("off");
  });

  it("applies config default when session is unset", () => {
    expect(resolveEffectiveResponseUsage(undefined, "tokens")).toBe("tokens");
    expect(resolveEffectiveResponseUsage(undefined, "full")).toBe("full");
  });

  it("applies per-channel config entry when session is unset", () => {
    const cfg = { default: "off", discord: "full", telegram: "tokens" } as const;
    expect(resolveEffectiveResponseUsage(undefined, cfg, "discord")).toBe("full");
    expect(resolveEffectiveResponseUsage(undefined, cfg, "telegram")).toBe("tokens");
    // Unknown channel falls back to config default
    expect(resolveEffectiveResponseUsage(undefined, cfg, "whatsapp")).toBe("off");
  });

  it("session explicit off overrides any config default", () => {
    // Explicit "off" is stored and wins — non-off config default cannot re-enable it.
    expect(resolveEffectiveResponseUsage("off", "tokens")).toBe("off");
    expect(resolveEffectiveResponseUsage("off", "full")).toBe("off");
    expect(
      resolveEffectiveResponseUsage("off", { default: "full", discord: "full" }, "discord"),
    ).toBe("off");
  });

  it("session explicit on value overrides config default", () => {
    expect(resolveEffectiveResponseUsage("tokens", "full")).toBe("tokens");
    expect(resolveEffectiveResponseUsage("full", "off")).toBe("full");
  });

  it("unset (undefined/null) falls through to config; explicit off does not", () => {
    // These two are distinct states:
    // - undefined = unset/inherit → gets config default
    // - "off"     = explicit off  → stays off
    const cfg = "tokens" as const;
    expect(resolveEffectiveResponseUsage(undefined, cfg)).toBe("tokens"); // inherits
    expect(resolveEffectiveResponseUsage("off", cfg)).toBe("off"); // explicit off persists
  });
});
