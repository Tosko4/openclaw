// Picker reads consume the Gateway publication; only an explicit retry starts discovery.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGateway } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  loadModelCatalog,
  modelCatalogRefreshError,
  subscribeModelCatalogChanges,
} from "../../lib/model-catalog-store.ts";
import type { ModelProvidersData } from "./load.ts";

type DiscoveryGateway = {
  connected: boolean;
  client: GatewayBrowserClient | null;
  epoch: number;
  isCurrent: (params: { client: GatewayBrowserClient; epoch: number }) => boolean;
};

export type CatalogDiscoveryController = {
  subscribe: (gateway: ApplicationGateway) => () => void;
  flushPublication: () => void;
  /** Whether a discovery request is currently in flight. */
  readonly discovering: boolean;
  /** A user-facing retry hint when discovery failed; null while clean. */
  readonly error: string | null;
  /** Retries a failed discovery. */
  retry: () => void;
  /** Resets request history and pending/error state when core data or its owner changes. */
  reset: (params?: { preservePublication?: boolean }) => void;
};

type CreateOptions = {
  getGateway: () => DiscoveryGateway;
  getAgentId: () => string;
  getAgentEpoch: () => number;
  getData: () => ModelProvidersData | null;
  setData: (data: ModelProvidersData) => void;
  requestUpdate: () => void;
  cancelCoreRefresh: () => void;
  isCoreLoading: () => boolean;
  readPublished: () => Promise<void>;
};

export function createCatalogDiscoveryController(
  options: CreateOptions,
): CatalogDiscoveryController {
  let pending: AbortController | null = null;
  let error: string | null = null;
  let publicationPending = false;

  const flushPublication = () => {
    // Core Task callbacks run before that Task completes its own settlement.
    queueMicrotask(() => {
      if (!publicationPending || pending || options.isCoreLoading()) {
        return;
      }
      publicationPending = false;
      void options.readPublished();
    });
  };

  const controller: CatalogDiscoveryController = {
    subscribe: (gateway) =>
      subscribeModelCatalogChanges(gateway, () => {
        publicationPending = true;
        flushPublication();
      }),
    flushPublication,
    get discovering() {
      return pending !== null;
    },
    get error() {
      return error;
    },
    retry() {
      void discover();
    },
    reset({ preservePublication = false } = {}) {
      if (!preservePublication) {
        publicationPending = false;
      }
      const retired = pending;
      pending = null;
      error = null;
      retired?.abort();
      options.requestUpdate();
    },
  };

  async function discover(): Promise<void> {
    const agentId = options.getAgentId();
    if (!agentId || pending) {
      return;
    }
    const gateway = options.getGateway();
    const client = gateway.client;
    if (!gateway.connected || !client) {
      return;
    }
    options.cancelCoreRefresh();
    const agentEpoch = options.getAgentEpoch();
    const clientEpoch = gateway.epoch;
    const request = new AbortController();
    const ownsResult = () =>
      pending === request &&
      gateway.isCurrent({ client, epoch: clientEpoch }) &&
      options.getAgentId() === agentId &&
      options.getAgentEpoch() === agentEpoch;
    pending = request;
    error = null;
    options.requestUpdate();
    try {
      const result = await loadModelCatalog(client, {
        agentId,
        refresh: true,
        signal: request.signal,
      });
      if (ownsResult()) {
        error = modelCatalogRefreshError(result, t("modelProviders.defaults.discoverFailed"));
        const data = options.getData();
        if (data) {
          options.setData({
            ...data,
            models: result.models,
            providerOutcomes: result.providerOutcomes ?? [],
            pendingProviders: result.pendingProviders,
            catalogError: null,
          });
        }
      }
    } catch (failure) {
      if (ownsResult()) {
        error = formatUiError(failure, "request failed");
      }
    } finally {
      if (pending === request) {
        pending = null;
        options.requestUpdate();
        flushPublication();
      }
    }
  }

  return controller;
}
