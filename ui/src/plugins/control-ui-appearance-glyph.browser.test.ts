import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createControlUiComponents } from "./control-ui-components.ts";

describe.runIf("__vitest_browser__" in globalThis)("mounted appearance glyph", () => {
  it("renders palette, custom, and cleared colors through the host component handle", async () => {
    const gateway = createGateway(createTestGatewayClient(() => ({})));
    const sessions = createSessions("main", []);
    const context = createContext(gateway, sessions);
    const lifetime = new AbortController();
    const onError = vi.fn();
    const container = document.createElement("div");
    container.style.setProperty("--session-color-blue", "rgb(30, 90, 180)");
    container.style.setProperty("--muted", "rgb(110, 115, 120)");
    container.style.color = "rgb(10, 20, 30)";
    document.body.append(container);
    onTestFinished(() => {
      lifetime.abort();
      container.remove();
    });
    const components = createControlUiComponents({
      current: () => context,
      signal: lifetime.signal,
      onError,
    });
    const props = { icon: "bot", color: "blue", fallback: "B" };
    const handle = components.mountAppearanceGlyph(container, props);
    const renderedColor = () => {
      const glyph = container.querySelector("openclaw-appearance-glyph");
      const svg = glyph?.shadowRoot?.querySelector("svg");
      return svg ? getComputedStyle(svg).color : null;
    };

    await expect.poll(renderedColor).toBe("rgb(30, 90, 180)");
    handle.update({ ...props, color: "#c04080" });
    await expect.poll(renderedColor).toBe("rgb(192, 64, 128)");
    handle.update({ ...props, color: null });
    await expect.poll(renderedColor).toBe("rgb(110, 115, 120)");
    expect(onError).not.toHaveBeenCalled();
  });
});
