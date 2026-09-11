/* @vitest-environment jsdom */
import { setImmediate as nextTurn } from "node:timers/promises";
import { html, LitElement, nothing } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { PluginDiscoveryCategory, PluginDiscoveryEntry } from "../../lib/plugins/index.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  refreshSection,
  sectionState,
  SECTION_NAMES,
  type SectionName,
} from "./plugin-discovery-controller.lifecycle-access.test-support.ts";
import { PluginDiscoveryController } from "./plugin-discovery-controller.ts";

type RequestKind = SectionName | "browse" | "hydrate";
type Observed = ReturnType<typeof sectionState>;
type Accepted = Record<SectionName, Observed>;
type Planned = ReturnType<typeof createDeferred<unknown>> & { used: boolean };
type RequestRow = {
  kind: RequestKind;
  method: string;
  params: unknown;
  signal: AbortSignal | undefined;
};

function snapshot(controller: PluginDiscoveryController): Accepted {
  return {
    categories: sectionState(controller, "categories"),
    featured: sectionState(controller, "featured"),
    trending: sectionState(controller, "trending"),
  };
}

function ids(items: Observed["items"]): string[] {
  return items.map((item) => ("id" in item ? item.id : item.slug));
}

class CatalogProofHost extends LitElement {
  private discovery?: PluginDiscoveryController;

  initialize(getGateway: () => ApplicationGateway, accepted: Accepted[]) {
    const gateway = new GatewayPageController(this, {
      getGateway,
      invalidateRequests: () => this.discovery?.invalidate(),
    });
    const controller = new PluginDiscoveryController(this, {
      getClient: () => gateway.client,
      isConnected: () => gateway.connected,
      capture: () => gateway.capture(),
      isCurrent: (scope) => gateway.isCurrent(scope),
      onEntriesChanged: () => accepted.push(snapshot(controller)),
    });
    this.discovery = controller;
    return controller;
  }

  override disconnectedCallback(): void {
    this.discovery?.disconnect();
    super.disconnectedCallback();
  }

  override render() {
    if (!this.discovery) {
      return nothing;
    }
    const current = snapshot(this.discovery);
    return html`<output
      >${JSON.stringify(
        SECTION_NAMES.map((name) => ({
          name,
          ids: ids(current[name].items),
          error: current[name].error,
          loading: current[name].loading,
        })),
      )}</output
    >`;
  }
}

// One class per file, with no fixture captured by its registered constructor.
customElements.define(`openclaw-catalog-section-proof-${crypto.randomUUID()}`, CatalogProofHost);

function requestKind(method: string, params: unknown): RequestKind {
  if (method === "plugins.catalog.categories") {
    return "categories";
  }
  if (method !== "plugins.catalog.browse" || !params || typeof params !== "object") {
    throw new Error(`Unexpected proof request: ${method}`);
  }
  if ("category" in params) {
    return "hydrate";
  }
  if ("intent" in params && (params.intent === "featured" || params.intent === "trending")) {
    return params.intent;
  }
  return "browse";
}

function entry(id: string): PluginDiscoveryEntry {
  return {
    id,
    catalog: { name: id, family: "code-plugin", official: false, categories: [] },
    local: {
      present: false,
      installed: false,
      enabled: false,
      state: "not-installed",
      action: "install",
    },
  };
}

function category(slug: string): PluginDiscoveryCategory {
  return { slug, label: slug, description: slug, icon: "package", order: 0 };
}

function response(kind: SectionName, prefix: string, size = 10) {
  return kind === "categories"
    ? { categories: Array.from({ length: size }, (_, i) => category(`${prefix}-${i}`)) }
    : {
        items: Array.from({ length: size }, (_, i) => entry(`${prefix}-${i}`)),
        remoteError: "partial catalog",
      };
}

function expectedIds(kind: SectionName, prefix: string) {
  return Array.from({ length: kind === "categories" ? 10 : 8 }, (_, i) => `${prefix}-${i}`);
}

const cleanups = new Set<() => Promise<void>>();

async function setup(connected = true) {
  const queue = new Map<RequestKind, Planned[]>();
  const plans: Planned[] = [];
  const requests: RequestRow[] = [];
  const unexpected: string[] = [];
  const owned = new Set<Promise<void>>();
  const request = createGatewayRequestMock((method, params, options) => {
    let kind: RequestKind;
    try {
      kind = requestKind(method, params);
    } catch (error) {
      unexpected.push(method);
      throw error;
    }
    const planned = queue.get(kind)?.shift();
    requests.push({ kind, method, params, signal: options?.signal });
    if (!planned) {
      unexpected.push(`${method}:${JSON.stringify(params)}`);
      throw new Error("Unplanned catalog proof request");
    }
    planned.used = true;
    return planned.promise;
  });
  const client = createTestGatewayClient(request);
  const hello = gatewayHelloForMethods(["plugins.catalog.categories", "plugins.catalog.browse"]);
  const initial: ApplicationGatewaySnapshot = {
    client,
    phase: connected ? "connected" : "reconnecting",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  let gateway = createApplicationGateway(initial);
  const accepted: Accepted[] = [];
  const host = new CatalogProofHost();
  const controller = host.initialize(() => gateway.gateway, accepted);
  // Section tests leave grouped overview to its separate causal test below.
  controller.intent = "official";
  const track = (promise: Promise<void>) => {
    owned.add(promise);
    void promise.then(
      () => owned.delete(promise),
      () => owned.delete(promise),
    );
    return promise;
  };
  const dispose = async () => {
    controller.disconnect();
    controller.invalidate();
    host.remove();
    for (const plan of plans) {
      plan.resolve({ items: [], categories: [] });
    }
    await Promise.allSettled(owned);
    await nextTurn();
    client.stop();
    expect(unexpected).toEqual([]);
  };
  cleanups.add(dispose);
  document.body.append(host);
  await host.updateComplete;
  return {
    client,
    controller,
    host,
    accepted,
    requests,
    enqueue(kind: RequestKind) {
      const plan = { ...createDeferred<unknown>(), used: false };
      plans.push(plan);
      const pending = queue.get(kind) ?? [];
      pending.push(plan);
      queue.set(kind, pending);
      return plan;
    },
    refresh(name: SectionName) {
      return track(refreshSection(controller, name));
    },
    browse() {
      return track(controller.refresh());
    },
    async connect(value: boolean) {
      gateway.publish({ ...initial, phase: value ? "connected" : "reconnecting" });
      await host.updateComplete;
    },
    async replaceSourceWithSameClient() {
      gateway = createApplicationGateway({ ...initial, hello: { ...hello } });
      host.requestUpdate();
      await host.updateComplete;
    },
  };
}

afterEach(async () => {
  const results = await Promise.allSettled([...cleanups].map((dispose) => dispose()));
  cleanups.clear();
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
});

describe("plugin catalog section lifecycle", () => {
  it.each(SECTION_NAMES)("retains and synchronously publishes %s state", async (name) => {
    const h = await setup();
    const first = h.enqueue(name);
    const initial = h.refresh(name);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.signal).toBeInstanceOf(AbortSignal);
    const wire = response(name, "first");
    first.resolve(wire);
    await initial;
    await h.host.updateComplete;
    const retained = sectionState(h.controller, name).items;
    expect(ids(retained)).toEqual(expectedIds(name, "first"));
    if (name === "categories") {
      expect(retained).toBe(wire.categories);
      expect(h.accepted).toHaveLength(0);
    } else {
      expect(retained).not.toBe(wire.items);
      expect(retained[0]).toBe(wire.items?.[0]);
      expect(h.accepted).toHaveLength(1);
      expect(h.accepted[0]?.[name].items).toBe(retained);
      expect(h.accepted[0]?.[name].error).toBe("partial catalog");
      expect(h.accepted[0]?.[name].loading).toBe(true);
    }

    const failed = h.enqueue(name);
    const refresh = h.refresh(name);
    expect(sectionState(h.controller, name).items).toBe(retained);
    expect(sectionState(h.controller, name).error).toBeNull();
    failed.reject(new Error("section unavailable"));
    await refresh;
    await h.host.updateComplete;
    expect(sectionState(h.controller, name).items).toBe(retained);
    expect(sectionState(h.controller, name).error).toBe("section unavailable");
    expect(h.host.shadowRoot?.textContent).toContain("section unavailable");

    const retry = h.enqueue(name);
    const retried = h.refresh(name);
    expect(sectionState(h.controller, name).error).toBeNull();
    expect(sectionState(h.controller, name).items).toBe(retained);
    retry.resolve(response(name, "recovered"));
    await retried;
    expect(ids(sectionState(h.controller, name).items)).toEqual(expectedIds(name, "recovered"));

    const lastFailure = h.enqueue(name);
    const failedAgain = h.refresh(name);
    lastFailure.reject(new Error("clear this error"));
    await failedAgain;
    h.controller.invalidate();
    expect(sectionState(h.controller, name).items).toEqual([]);
    expect(sectionState(h.controller, name).error).toBeNull();
    await h.host.updateComplete;
    expect(h.host.shadowRoot?.textContent).not.toContain("recovered");
    expect(h.host.shadowRoot?.textContent).not.toContain("clear this error");
  });

  it.each(SECTION_NAMES)(
    "retires stale %s completions across source and host lifetimes",
    async (name) => {
      const h = await setup();
      const older = h.enqueue(name);
      const oldRun = h.refresh(name);
      const fresh = h.enqueue(name);
      const freshRun = h.refresh(name);
      expect(h.requests[0]?.signal?.aborted).toBe(true);
      fresh.resolve(response(name, "fresh"));
      await freshRun;
      older.resolve(response(name, "stale"));
      await oldRun;
      expect(ids(sectionState(h.controller, name).items)).toEqual(expectedIds(name, "fresh"));

      const replaced = h.enqueue(name);
      const replacedRun = h.refresh(name);
      await h.replaceSourceWithSameClient();
      expect(h.requests[2]?.signal?.aborted).toBe(true);
      expect(sectionState(h.controller, name).items).toEqual([]);
      const replacement = h.enqueue(name);
      const replacementRun = h.refresh(name);
      replaced.reject(new Error("retired source error"));
      await replacedRun;
      expect(sectionState(h.controller, name).error).toBeNull();
      if (name !== "categories") {
        expect(sectionState(h.controller, name).loading).toBe(true);
      }
      replacement.resolve(response(name, "replacement"));
      await replacementRun;

      const detached = h.enqueue(name);
      const detachedRun = h.refresh(name);
      h.host.remove();
      expect(h.requests[4]?.signal?.aborted).toBe(true);
      expect(sectionState(h.controller, name).items).toEqual([]);
      detached.resolve(response(name, "detached"));
      await detachedRun;
      expect(sectionState(h.controller, name).items).toEqual([]);
      expect(sectionState(h.controller, name).error).toBeNull();
      document.body.append(h.host);
      await h.host.updateComplete;
      const reconnected = h.enqueue(name);
      const reconnectedRun = h.refresh(name);
      reconnected.resolve(response(name, "reconnected"));
      await reconnectedRun;
      expect(ids(sectionState(h.controller, name).items)).toEqual(expectedIds(name, "reconnected"));
    },
  );

  it("admits initial section work once and does not autoretry completed empty or failed reads", async () => {
    const h = await setup(false);
    h.controller.ensureInitial();
    expect(h.requests).toEqual([]);
    await h.connect(true);
    const browse = h.enqueue("browse");
    const categories = h.enqueue("categories");
    const featured = h.enqueue("featured");
    const trending = h.enqueue("trending");
    h.controller.ensureInitial();
    h.controller.ensureInitial();
    expect(h.requests.map((row) => row.kind)).toEqual([
      "browse",
      "categories",
      "featured",
      "trending",
    ]);
    expect(h.requests.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "plugins.catalog.browse", params: { intent: "official", pageSize: 100 } },
      { method: "plugins.catalog.categories", params: {} },
      { method: "plugins.catalog.browse", params: { intent: "featured", pageSize: 8 } },
      { method: "plugins.catalog.browse", params: { intent: "trending", pageSize: 8 } },
    ]);
    browse.resolve({ items: [] });
    categories.reject(new Error("categories unavailable"));
    featured.resolve({ items: [] });
    trending.resolve({ items: [] });
    await nextTurn();
    await h.host.updateComplete;
    h.controller.ensureInitial();
    expect(h.requests).toHaveLength(4);
    expect(sectionState(h.controller, "categories").error).toBe("categories unavailable");
  });

  it.each(["success", "failure"] as const)(
    "awaits category hydration %s before refresh settles",
    async (outcome) => {
      const h = await setup();
      h.controller.intent = "all";
      const browse = h.enqueue("browse");
      const browsed = h.browse();
      browse.resolve({ items: [entry("base")] });
      await browsed;
      const categories = h.enqueue("categories");
      const hydration = h.enqueue("hydrate");
      const refreshed = h.refresh("categories");
      let settled = false;
      void refreshed.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      categories.resolve({ categories: [category("tools")] });
      await waitForFast(() => expect(hydration.used).toBe(true));
      // The request has started; one ordinary event-loop turn drains runnable
      // continuations without releasing its deliberately held response.
      await nextTurn();
      expect(settled).toBe(false);
      expect(h.requests.at(-1)?.params).toEqual({ intent: "all", category: "tools", pageSize: 8 });
      if (outcome === "success") {
        hydration.resolve({ items: [entry("hydrated")] });
      } else {
        hydration.reject(new Error("hydration unavailable"));
      }
      await refreshed;
      expect(settled).toBe(true);
      if (outcome === "success") {
        expect(h.controller.result?.items.map((item) => item.id)).toEqual(["base", "hydrated"]);
      } else {
        expect(h.controller.remoteError).toBe("hydration unavailable");
        expect(h.controller.result?.items.map((item) => item.id)).toEqual(["base"]);
      }
    },
  );
});
