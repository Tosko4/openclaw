import { render } from "lit";
import { vi } from "vitest";
import type { ModelCatalogEntry, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../../app/context.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { NewSessionModelControl } from "./model-control.ts";

export function stubSessionDefaults(
  readDefaults: () => SessionsListResult["defaults"] = () => ({
    model: null,
    modelProvider: null,
    contextTokens: null,
  }),
): ApplicationContext["sessions"]["observeList"] {
  return (scope, listener) => {
    let active = true;
    const publish = () => {
      if (active) {
        listener({
          agentId: scope.agentId ?? null,
          loading: false,
          error: null,
          result: { ts: 1, path: "", count: 0, sessions: [], defaults: readDefaults() },
        });
      }
    };
    publish();
    return {
      refresh: async () => publish(),
      dispose: () => {
        active = false;
      },
    };
  };
}

export function contextWith(
  models: ModelCatalogEntry[],
  runtime = "openclaw",
  featureMethods: string[] = [],
  cloudPlacementSupported?: boolean,
  devicePlacementSupported?: boolean,
) {
  const request = vi.fn().mockResolvedValue({ models });
  const navigate = vi.fn();
  const listeners = new Set<Parameters<ApplicationGateway["subscribeEvents"]>[0]>();
  const emitCatalogChanged = () => {
    invalidateChatMetadataStore(context.gateway.snapshot.client!);
    for (const listener of listeners) {
      listener({ type: "event", event: "chat.metadata.changed", payload: {} });
    }
  };
  const context = {
    navigate,
    gateway: {
      subscribeEvents: (listener: Parameters<ApplicationGateway["subscribeEvents"]>[0]) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: {
        phase: "connected",
        client: { request },
        hello: { features: { methods: featureMethods } },
      },
    },
    sessions: {
      observeList: stubSessionDefaults(() => context.sessions.state.result!.defaults),
      state: {
        result: {
          defaults: {
            model: "openai/gpt-5.6-luna",
            modelProvider: "openai",
            agentRuntime: {
              id: runtime,
              ...(cloudPlacementSupported === undefined ? {} : { cloudPlacementSupported }),
              ...(devicePlacementSupported === undefined ? {} : { devicePlacementSupported }),
              source: "defaults",
            },
          },
          sessions: [],
        },
      },
    },
  } as unknown as ApplicationContext;
  return { context, navigate, request, emitCatalogChanged };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export function renderControl(
  control: NewSessionModelControl,
  context: ApplicationContext,
  agentId = "main",
) {
  const container = document.createElement("div");
  render(
    control.render({
      agentId,
      context,
      sending: false,
    }),
    container,
  );
  return container;
}
