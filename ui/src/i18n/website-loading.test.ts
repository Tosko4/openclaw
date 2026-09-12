import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => vi.resetModules());

let restoreI18n: (() => Promise<void>) | undefined;
afterEach(async () => {
  await restoreI18n?.();
});

describe("website widget English loading", () => {
  it("loads website fallback copy with the widget while preserving shared board labels", async () => {
    const { captureI18nStateForTesting, createI18nManagerForTesting } =
      await import("./lib/translate.test-support.ts");
    restoreI18n = captureI18nStateForTesting();
    const { en } = await import("./locales/en.ts");
    const board = en.board;
    const manager = createI18nManagerForTesting(async () => ({ common: { health: "Gesundheit" } }));
    expect(manager.t("board.widget.kindWebsite")).toBe("Website");
    expect(manager.t("board.widget.websiteOpen")).toBe("board.widget.websiteOpen");
    expect(manager.t("board.widget.websiteEmbedHint")).toBe("board.widget.websiteEmbedHint");
    expect(manager.t("board.widget.websiteSameOrigin")).toBe("board.widget.websiteSameOrigin");

    await manager.setLocale("de");
    await import("../lib/board/widgets/website.ts");

    expect(en.board).toBe(board);
    expect(manager.t("board.label")).toBe("Session dashboard");
    expect(manager.t("board.widget.kindWebsite")).toBe("Website");
    expect(manager.t("common.health")).toBe("Gesundheit");
    expect(manager.t("board.widget.websiteOpen")).toBe("Open website");
    expect(manager.t("board.widget.websiteEmbedHint")).toBe(
      "If this site does not load here, open it in a new tab.",
    );
    expect(manager.t("board.widget.websiteSameOrigin")).toBe(
      "Open this website in a new tab. Gateway and Control UI pages cannot be embedded in a website widget.",
    );
  });
});
