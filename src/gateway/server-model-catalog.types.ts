import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { ModelManifestNormalizationContext } from "../agents/model-ref-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderThinkingRegistry } from "../plugins/provider-thinking.types.js";

/** Catalog entries and policy come from the same completed prepared generation. */
export type PreparedGatewayModelCatalog = {
  entries: ModelCatalogEntry[];
  /** Full prepared evidence; a list of display rows alone cannot establish model absence. */
  snapshot?: ModelCatalogSnapshot;
  manifestPlugins?: ModelManifestNormalizationContext["manifestPlugins"];
  pluginRegistry?: ProviderThinkingRegistry;
};

export type GatewayModelCatalogSnapshot = ModelCatalogSnapshot & {
  agentId: string;
  agentDir: string;
  catalogComplete: boolean;
  workspaceDir: string;
  config: OpenClawConfig;
};
