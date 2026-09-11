/* @vitest-environment jsdom */

import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelCatalogResult } from "../../api/types.ts";
import type { SelectPicker } from "../../components/select-picker.ts";
import { updatePickers } from "../../test-helpers/select-picker.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import {
  appendPage,
  createHarness,
  type ModelProvidersPageTestElement,
} from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function modelPickers(page: Element): SelectPicker[] {
  return [
    ...page.querySelectorAll<SelectPicker>(".model-providers__defaults openclaw-select-picker"),
  ];
}

async function openModelPicker(page: HTMLElement, index = 0): Promise<void> {
  await updatePickers(page);
  const picker = modelPickers(page)[index];
  expect(picker).toBeDefined();
  const trigger = picker!.querySelector<HTMLButtonElement>(".picker-select__trigger");
  expect(trigger).not.toBeNull();
  if (trigger!.getAttribute("aria-expanded") === "true") {
    trigger!.click();
    await picker!.updateComplete;
  }
  trigger!.click();
  await picker!.updateComplete;
}

async function retryCatalog(page: ModelProvidersPageTestElement): Promise<void> {
  await page.updateComplete;
  const retry = page.querySelector<HTMLButtonElement>(".model-providers__catalog-progress button");
  expect(retry?.textContent?.trim()).toBe("Retry");
  retry!.click();
  await page.updateComplete;
}

async function drainPageUpdates(page: ModelProvidersPageTestElement): Promise<void> {
  // Drain every promise continuation before checking that a retired result stayed absent.
  await setImmediate();
  await page.updateComplete;
  await updatePickers(page);
}

const preparedCatalog: ModelCatalogResult = {
  models: [
    { id: "prepared-primary", name: "Prepared primary", provider: "openai", available: true },
    { id: "prepared-utility", name: "Prepared utility", provider: "openai", available: true },
    { id: "prepared-fallback", name: "Prepared fallback", provider: "openai", available: true },
  ],
};

const savedModelConfig = {
  agents: {
    defaults: {
      model: {
        primary: "openai/prepared-primary",
        fallbacks: ["openai/prepared-fallback"],
      },
      utilityModel: "openai/prepared-utility",
    },
  },
};

function createCatalogHarness() {
  const harness = createHarness("main");
  const originalRequest = harness.request.getMockImplementation()!;
  const discover = vi.fn<() => Promise<ModelCatalogResult>>();
  const readPublished = vi.fn((): ModelCatalogResult => preparedCatalog);
  const catalogRequest = async (method: string, params?: { refresh?: boolean }) => {
    if (method === "models.list") {
      return params?.refresh ? discover() : readPublished();
    }
    if (method === "config.get") {
      return { config: savedModelConfig, hash: "saved-model-config" };
    }
    return originalRequest(method);
  };
  harness.request.mockImplementation(catalogRequest);
  return { ...harness, discover, readPublished, catalogRequest };
}

describe("Models page catalog publication", () => {
  it.each([
    { picker: "primary", index: 0 },
    { picker: "utility", index: 1 },
    { picker: "fallback", index: 2 },
  ])(
    "Models page $picker picker opens without a request and preserves saved choices as publication completes",
    async ({ index }) => {
      const { context, request, discover, readPublished, runtimeConfig, publishEvent } =
        createCatalogHarness();
      readPublished.mockReturnValue({ ...preparedCatalog, pendingProviders: ["openai"] });
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      await page.updateComplete;
      expect(modelPickers(page)).toHaveLength(3);
      const requestsAfterLoad = request.mock.calls.filter(([method]) => method === "models.list");
      expect(requestsAfterLoad).toHaveLength(1);

      await openModelPicker(page, index);
      await drainPageUpdates(page);
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual(
        requestsAfterLoad,
      );
      expect(discover).not.toHaveBeenCalled();
      expect(
        page.querySelector('.model-providers__catalog-progress[role="status"]'),
      ).not.toBeNull();
      expect(
        modelPickers(page).map(
          (picker) => picker.querySelector<HTMLButtonElement>(".picker-select__trigger")?.disabled,
        ),
      ).toEqual([false, false, false]);

      const published: ModelCatalogResult = {
        models: [
          ...preparedCatalog.models,
          { id: "discovered", name: "Discovered model", provider: "openai", available: true },
          ...[
            "alternative-a",
            "alternative-b",
            "alternative-c",
            "alternative-d",
            "alternative-e",
          ].map((id) => ({ id, name: id, provider: "openai", available: true })),
        ],
      };
      readPublished.mockReturnValue(published);
      publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
      await waitForFast(() => expect(page.data?.models).toEqual(published.models));
      await drainPageUpdates(page);
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
      for (const picker of modelPickers(page)) {
        expect(
          picker.querySelector('[role="option"][data-value="openai/discovered"]'),
        ).not.toBeNull();
      }
      expect(
        modelPickers(page).map((picker) =>
          picker.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("data-value"),
        ),
      ).toEqual(["openai/prepared-primary", "openai/prepared-utility", "openai/prepared-fallback"]);
      await openModelPicker(page, 1);
      const utility = modelPickers(page)[1]!;
      const search = utility.querySelector<HTMLInputElement>('input[type="search"]');
      expect(search).not.toBeNull();
      search!.value = "Discovered";
      search!.dispatchEvent(new Event("input", { bubbles: true }));
      await utility.updateComplete;
      expect(
        [...utility.querySelectorAll<HTMLElement>('[role="option"]')].map(
          (option) => option.dataset.value,
        ),
      ).toEqual(["openai/discovered"]);
      expect(utility.querySelector(".picker-select__trigger")?.textContent).toContain(
        "Prepared utility",
      );
      expect(page.data?.config).toEqual(savedModelConfig);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(2);
    },
  );

  it.each([false, true])(
    "Models page shows a published failure without changing saved choices (retained rows: %s)",
    async (hasRows) => {
      const { context, discover, readPublished, runtimeConfig, publishEvent } =
        createCatalogHarness();
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      const models = hasRows ? preparedCatalog.models : [];
      readPublished.mockReturnValue({ models, refreshFailed: true });

      publishEvent({ type: "event", event: "config.changed", payload: {} });
      await waitForFast(() =>
        expect(
          page.querySelector('.model-providers__catalog-progress[role="alert"]')?.textContent,
        ).toContain("More models could not be discovered."),
      );
      await openModelPicker(page);
      expect(page.data?.models).toEqual(models);
      expect(page.data?.config).toEqual(savedModelConfig);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
      expect(
        page.querySelector(".model-providers__catalog-progress button")?.textContent,
      ).toContain("Retry");
    },
  );

  it.each(["rejected request", "nonfatal refresh failure"])(
    "Models page Retry retains choices after a %s and displays the recovered catalog",
    async (failure) => {
      const { context, discover, readPublished, runtimeConfig } = createCatalogHarness();
      readPublished.mockReturnValue({ ...preparedCatalog, refreshFailed: true });
      const pending = deferred<ModelCatalogResult>();
      if (failure === "rejected request") {
        discover.mockRejectedValueOnce(new Error("discovery failed"));
      } else {
        discover.mockResolvedValueOnce({ ...preparedCatalog, refreshFailed: true });
      }
      discover.mockReturnValueOnce(pending.promise);
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));

      await retryCatalog(page);
      await waitForFast(() =>
        expect(
          page.querySelector('.model-providers__catalog-progress[role="alert"]'),
        ).not.toBeNull(),
      );
      expect(page.data?.models).toEqual(preparedCatalog.models);
      await retryCatalog(page);
      expect(discover).toHaveBeenCalledTimes(2);
      expect(
        page.querySelector('.model-providers__catalog-progress[role="status"]'),
      ).not.toBeNull();
      await openModelPicker(page);
      expect(discover).toHaveBeenCalledTimes(2);
      pending.resolve({
        models: [
          ...preparedCatalog.models,
          { id: "recovered", name: "Recovered model", provider: "openai", available: true },
        ],
      });
      await waitForFast(() => expect(page.data?.models?.at(-1)?.id).toBe("recovered"));
      await drainPageUpdates(page);
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
      expect(page.querySelector('[role="option"][data-value="openai/recovered"]')).not.toBeNull();
      expect(page.data?.catalogError).toBeNull();
      expect(page.data?.config).toEqual(savedModelConfig);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "Models page Retry clears a catalog error without hiding unrelated auth errors (auth fails: %s)",
    async (authFails) => {
      const { context, discover, request, catalogRequest } = createCatalogHarness();
      request.mockImplementation(async (method: string, params?: { refresh?: boolean }) => {
        if (method === "models.authStatus" && authFails) {
          throw new Error("Credential status unavailable");
        }
        return catalogRequest(method, params);
      });
      discover
        .mockRejectedValueOnce(new Error("Initial catalog unavailable"))
        .mockResolvedValueOnce({
          models: [
            { id: "recovered", name: "Recovered model", provider: "openai", available: true },
          ],
        });
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      await page.updateComplete;

      page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
      await waitForFast(() =>
        expect(page.data?.catalogError).toContain("Initial catalog unavailable"),
      );
      await retryCatalog(page);
      await waitForFast(() => expect(page.data?.models?.[0]?.id).toBe("recovered"));
      await drainPageUpdates(page);
      expect(page.data?.catalogError).toBeNull();
      expect(page.textContent).not.toContain("Initial catalog unavailable");
      expect(page.data?.error).toBe(authFails ? "Credential status unavailable" : null);
      if (authFails) {
        expect(page.textContent).toContain("Credential status unavailable");
      }
    },
  );

  it.each(["Refresh button", "route data"] as const)(
    "Models page retains newer %s data when an older Retry response arrives",
    async (replacement) => {
      const { context, discover, readPublished, snapshot } = createCatalogHarness();
      readPublished.mockReturnValue({ ...preparedCatalog, refreshFailed: true });
      const pending = deferred<ModelCatalogResult>();
      const newer: ModelCatalogResult = {
        models: [{ id: "newer", name: "Newer model", provider: "openai", available: true }],
        providerOutcomes: [{ provider: "openai", status: "ready" }],
      };
      discover.mockReturnValueOnce(pending.promise).mockResolvedValue(newer);
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      await retryCatalog(page);

      if (replacement === "Refresh button") {
        page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
      } else {
        page.routeData = {
          gateway: context.gateway,
          gatewaySnapshot: snapshot,
          client: snapshot.client,
          agentId: "main",
          data: {
            ...EMPTY_MODEL_PROVIDERS_DATA,
            config: savedModelConfig,
            models: newer.models,
            providerOutcomes: newer.providerOutcomes!,
            updatedAt: 2,
          },
        };
      }
      await waitForFast(() => expect(page.data?.models).toEqual(newer.models));
      pending.resolve({
        models: [{ id: "retired", name: "Retired model", provider: "openai", available: true }],
        providerOutcomes: [{ provider: "openai", status: "unavailable" }],
      });
      await drainPageUpdates(page);
      expect(page.data?.models).toEqual(newer.models);
      expect(page.data?.providerOutcomes).toEqual(newer.providerOutcomes);
      expect(page.querySelector('[role="option"][data-value="openai/newer"]')).not.toBeNull();
      expect(page.querySelector('[role="option"][data-value="openai/retired"]')).toBeNull();
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "Models page keeps its new Retry active when a retired Retry completes with %s",
    async (completion) => {
      const { context, discover, readPublished, snapshot } = createCatalogHarness();
      readPublished.mockReturnValue({ ...preparedCatalog, refreshFailed: true });
      const retired = deferred<ModelCatalogResult>();
      const current = deferred<ModelCatalogResult>();
      discover.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise);
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      await retryCatalog(page);
      page.routeData = {
        gateway: context.gateway,
        gatewaySnapshot: snapshot,
        client: snapshot.client,
        agentId: "main",
        data: {
          ...EMPTY_MODEL_PROVIDERS_DATA,
          config: savedModelConfig,
          models: preparedCatalog.models,
          catalogError: "Catalog unavailable",
          updatedAt: 2,
        },
      };
      await page.updateComplete;
      await retryCatalog(page);

      if (completion === "resolve") {
        retired.resolve({ models: [{ id: "retired", name: "Retired", provider: "openai" }] });
      } else {
        retired.reject(new Error("Retired discovery failed"));
      }
      await drainPageUpdates(page);
      expect(page.data?.models).toEqual(preparedCatalog.models);
      expect(
        page.querySelector('.model-providers__catalog-progress[role="status"]'),
      ).not.toBeNull();
      expect(page.querySelector('.model-providers__catalog-progress[role="alert"]')).toBeNull();
      await openModelPicker(page, 2);
      expect(discover).toHaveBeenCalledTimes(2);
      current.resolve({
        models: [{ id: "current", name: "Current model", provider: "openai", available: true }],
      });
      await waitForFast(() => expect(page.data?.models?.[0]?.id).toBe("current"));
      await drainPageUpdates(page);
      expect(page.querySelector('[role="option"][data-value="openai/current"]')).not.toBeNull();
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
    },
  );

  it("Models page for another agent keeps its Retry alive when the first page retires its request", async () => {
    const { context, discover, readPublished, snapshot } = createCatalogHarness();
    readPublished.mockReturnValue({ ...preparedCatalog, refreshFailed: true });
    const writer = createHarness("writer");
    const pending = deferred<ModelCatalogResult>();
    discover.mockReturnValue(pending.promise);
    const first = appendPage(context);
    const second = appendPage({ ...context, agentSelection: writer.context.agentSelection });
    await waitForFast(() => expect(first.data?.config).toEqual(savedModelConfig));
    await waitForFast(() => expect(second.data?.config).toEqual(savedModelConfig));
    await retryCatalog(first);
    await retryCatalog(second);
    expect(first.selectedAgentId).toBe("main");
    expect(second.selectedAgentId).toBe("writer");
    first.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: snapshot,
      client: snapshot.client,
      agentId: "main",
      data: {
        ...EMPTY_MODEL_PROVIDERS_DATA,
        config: savedModelConfig,
        models: preparedCatalog.models,
        updatedAt: 2,
      },
    };
    await first.updateComplete;

    pending.resolve({
      models: [{ id: "shared", name: "Shared discovery", provider: "openai", available: true }],
    });
    await waitForFast(() => expect(second.data?.models?.[0]?.id).toBe("shared"));
    await drainPageUpdates(first);
    await drainPageUpdates(second);
    expect(first.data?.models).toEqual(preparedCatalog.models);
    expect(second.querySelector('[role="option"][data-value="openai/shared"]')).not.toBeNull();
    expect(first.querySelector('[role="option"][data-value="openai/shared"]')).toBeNull();
    expect(first.querySelector(".model-providers__catalog-progress")).toBeNull();
    expect(second.querySelector(".model-providers__catalog-progress")).toBeNull();
  });
});
