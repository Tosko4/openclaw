/* @vitest-environment jsdom */

import { createRouter } from "@openclaw/uirouter";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ModelCatalogResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  appendPage,
  createAuthStatus,
  createHarness,
  openModelPicker,
  waitForProviders,
} from "./model-providers-page.test-support.ts";
import { page as modelProvidersRoute, type ModelProvidersRouteData } from "./route.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("reads the current catalog when publication retires the route preload before mounting", async () => {
  const { context, request, publishEvent } = createHarness("main");
  const originalRequest = request.getMockImplementation()!;
  const started = createDeferred();
  const pending = createDeferred<ModelCatalogResult>();
  const current: ModelCatalogResult = {
    models: [{ id: "current", name: "Current model", provider: "openai", available: true }],
    providerOutcomes: [{ provider: "openai", status: "ready" }],
  };
  let initialRead = true;
  request.mockImplementation((method: string) => {
    if (method === "models.list") {
      if (initialRead) {
        initialRead = false;
        started.resolve();
        return pending.promise;
      }
      return Promise.resolve(current);
    }
    return method === "models.authStatus"
      ? Promise.resolve(createAuthStatus())
      : originalRequest(method);
  });
  const router = createRouter<"model-providers", typeof context, null, ModelProvidersRouteData>({
    routes: [{ ...modelProvidersRoute, component: () => null }],
  });
  try {
    const loading = router.navigate("model-providers", context);
    await started.promise;
    publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
    pending.resolve({
      models: [{ id: "retired", name: "Retired model", provider: "openai", available: true }],
      providerOutcomes: current.providerOutcomes,
    });
    await loading;
    const page = appendPage(context);
    page.routeData = router.getState().matches[0]?.data;
    await waitForProviders(page);
    await waitForFast(() =>
      expect(
        page
          .querySelector('[data-provider-id="openai"] .model-providers__head .settings-status')
          ?.textContent?.trim(),
      ).toBe("Ready"),
    );
    await openModelPicker(page);
    expect(
      page.querySelector('[role="option"][data-value="openai/current"]')?.textContent,
    ).toContain("Current model");
    expect(page.querySelector('[role="option"][data-value="openai/retired"]')).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual([
      ["models.list", { agentId: "main", view: "configured" }, { signal: expect.any(AbortSignal) }],
      ["models.list", { agentId: "main", view: "configured" }, { signal: expect.any(AbortSignal) }],
    ]);
  } finally {
    pending.resolve(current);
    router.stop();
  }
});
