/** Serializable catalog worker contract. Shared without importing the parent dispatcher. */
import type { serializeConfigResolutionFacts } from "../config/resolution-facts.js";
import type { Model } from "../llm/types.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PreparedSyntheticAuthFacts } from "../plugins/provider-synthetic-auth.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ModelCatalogAuthLabels } from "./model-catalog-auth-labels.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import type { PreparedModelRuntimeCatalogFacts } from "./prepared-model-runtime.catalog-contract.js";
import { fingerprintPreparedRuntimeFacts } from "./prepared-model-runtime.fingerprint.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";
import type { AuthStorageData } from "./sessions/auth-storage.js";

export type PreparedModelCatalogWorkerInput = Readonly<{
  kind: "catalog";
  generationFingerprint: string;
  input: PreparedModelRuntimeInput & { env: NodeJS.ProcessEnv };
  sourceConfigForSecrets: PreparedModelRuntimeInput["config"];
  configResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  sourceConfigResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  authStore: AuthProfileStore;
  providerIds: readonly string[];
  preferBuiltPluginArtifacts: boolean;
  pluginMetadataSnapshot: Omit<PluginMetadataSnapshot, "normalizePluginId">;
}>;

export type PreparedModelCatalogWorkerData = PreparedModelCatalogWorkerInput & {
  sourceCaptureDirectory: string;
};

export type PreparedModelWorkerCommand =
  | Readonly<{ kind: "catalog"; providerIds?: readonly string[] }>
  | Readonly<{
      kind: "auth-refresh";
      profileIds?: readonly string[];
      providerIds: readonly string[];
    }>;

export type PreparedModelWorkerRequest = PreparedModelWorkerCommand &
  Readonly<{ syntheticAuth: PreparedSyntheticAuthFacts }>;

export type PreparedModelWorkerResult =
  | Readonly<{
      status: "ok";
      kind: "catalog";
      generationFingerprint: string;
      snapshot: ModelCatalogSnapshot;
      runtimeModels: Map<string, Model[]>;
      providerExpiries: Map<string, number>;
      configuredRuntimeModels: PreparedModelRuntimeCatalogFacts["configuredRuntimeModels"];
      credentials: Readonly<AuthStorageData>;
      providerAuthLabels: ModelCatalogAuthLabels;
      authStore: AuthProfileStore;
      authModes: PreparedAgentCredentialModes;
    }>
  | Readonly<{
      status: "ok";
      kind: "auth-refresh";
      generationFingerprint: string;
      authStore: AuthProfileStore;
      authModes: PreparedAgentCredentialModes;
      credentials: Readonly<AuthStorageData>;
    }>
  | Readonly<{
      status: "generation-mismatch";
      generationFingerprint: string;
      reconstructedFingerprint: string;
    }>
  | Readonly<{ status: "failed"; error: string }>;

// Cold source/plugin loading can take well over a minute. Three minutes preserves exact full-view
// discovery while bounding a wedged provider; expiry rejects and never returns partial results.
export const PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS = 180_000;
export function fingerprintPreparedModelWorkerRequest(
  input: PreparedModelCatalogWorkerInput,
  request: PreparedModelWorkerRequest,
): string {
  return fingerprintPreparedRuntimeFacts([input.generationFingerprint, request]);
}

function fingerprintPreparedModelCatalogPlugins(snapshot: PluginMetadataSnapshot): string {
  return fingerprintPreparedRuntimeFacts({
    config: snapshot.configFingerprint ?? null,
    index: resolveInstalledManifestRegistryIndexFingerprint(snapshot.index),
    pluginIds: snapshot.pluginIds ?? null,
    policy: snapshot.policyHash,
    workspaceDir: snapshot.workspaceDir ?? null,
  });
}

export function fingerprintPreparedModelCatalogGeneration(params: {
  input: PreparedModelRuntimeInput;
  sourceConfigForSecrets: PreparedModelRuntimeInput["config"];
  configResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  sourceConfigResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  authStore: AuthProfileStore;
  providerIds: readonly string[];
  preferBuiltPluginArtifacts?: boolean;
  pluginMetadataSnapshot: PluginMetadataSnapshot;
}): string {
  return fingerprintPreparedRuntimeFacts({
    input: params.input,
    sourceConfigForSecrets: params.sourceConfigForSecrets,
    configResolutionFacts: params.configResolutionFacts,
    sourceConfigResolutionFacts: params.sourceConfigResolutionFacts,
    authStore: params.authStore,
    providerIds: params.providerIds,
    preferBuiltPluginArtifacts: params.preferBuiltPluginArtifacts === true,
    pluginFingerprint: fingerprintPreparedModelCatalogPlugins(params.pluginMetadataSnapshot),
  });
}
