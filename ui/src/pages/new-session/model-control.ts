import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type {
  ChatAccountSelection,
  UserModelAccount,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type {
  FastMode,
  GatewayAgentRow,
  ModelCatalogEntry,
  ModelCatalogResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { buildQualifiedChatModelValue } from "../../lib/chat/model-ref.ts";
import {
  isChatFastModeProviderSupported,
  chatModelUnavailableMessage,
  normalizeChatFastModeInput,
  resolveChatModelUnavailableReason,
} from "../../lib/chat/model-select-state.ts";
import { resolveThinkingProfileForSession } from "../../lib/chat/thinking.ts";
import {
  invalidateModelCatalogCache,
  type ModelCatalogReadScope,
} from "../../lib/model-catalog-cache.ts";
import {
  loadModelCatalog,
  peekModelCatalog,
  resolveModelCatalogState,
  subscribeModelCatalogChanges,
} from "../../lib/model-catalog-store.ts";
import type { SessionListSnapshot } from "../../lib/sessions/session-capability.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { renderChatModelAccountControl } from "../chat/components/chat-model-account-control.ts";
import {
  renderChatModelControls,
  type ChatModelCatalogState,
} from "../chat/components/chat-model-controls.ts";
import { CatalogTargetDiscovery } from "./catalog-target.ts";
import { draftCloudProfileSupportsExecutionMode, type DraftCloudProfile } from "./discovery.ts";
import {
  reconcileDraftModelSelection,
  resolveDraftModelTarget,
  resolveDraftThinkingTarget,
} from "./model-target.ts";
import type { NewSessionPreference } from "./preferences.ts";

type NewSessionMetadataClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
type GatewayAgentRuntime = NonNullable<GatewayAgentRow["agentRuntime"]> & {
  cloudPlacementSupported?: boolean;
};
type NewSessionMetadataState = ChatModelCatalogState & {
  catalog: ModelCatalogEntry[];
  accountSelection?: ChatAccountSelection;
};
type NewSessionMetadataLoadOptions = {
  preference?: NewSessionPreference | null;
};

export class NewSessionModelControl {
  private selectionGeneration = 0;
  private agentId = "";
  private metadataState: NewSessionMetadataState = {
    catalog: [],
    hasSnapshot: false,
    status: "idle",
  };
  private metadataRequest: AbortController | undefined;
  private metadataClient: NewSessionMetadataClient | undefined;
  private metadataScope: ModelCatalogReadScope | undefined;
  private metadataIdentityId: string | undefined;
  private metadataGateway: ApplicationContext["gateway"] | undefined;
  private metadataHello: ApplicationContext["gateway"]["snapshot"]["hello"] | undefined;
  private metadataUnsubscribe: (() => void) | undefined;
  private defaultsObservation:
    | ReturnType<ApplicationContext["sessions"]["observeList"]>
    | undefined;
  private defaultsSnapshot: SessionListSnapshot | undefined;
  private draftAccount:
    | (Pick<UserModelAccount, "authProfileId" | "provider"> & { model: string })
    | undefined;
  private restoringPreference = false;
  private pendingPreference: NewSessionPreference | null | undefined;
  private pendingContext: ApplicationContext | undefined;
  private pendingSelectionGeneration = 0;
  private readonly catalogTargets: CatalogTargetDiscovery;
  selected = "";
  contextWindow = "";
  thinkingLevel = "";
  fastMode: FastMode | undefined;

  constructor(
    private readonly notify: () => void,
    private readonly onSelectionChange: (selection: {
      model: string;
      thinkingLevel: string;
    }) => void = () => undefined,
    private readonly onCatalogTargetSelect: (catalogId: string) => void = () => undefined,
  ) {
    this.catalogTargets = new CatalogTargetDiscovery(notify);
  }

  private get catalog(): ModelCatalogEntry[] {
    return this.metadataState.catalog;
  }

  private get effectiveModel(): string {
    return this.draftAccount?.model ?? this.selected;
  }

  private clearMetadataSubscription() {
    this.metadataRequest?.abort();
    this.metadataRequest = undefined;
    this.metadataUnsubscribe?.();
    this.metadataUnsubscribe = undefined;
    this.defaultsObservation?.dispose();
    this.defaultsObservation = undefined;
    this.defaultsSnapshot = undefined;
    this.metadataScope = undefined;
    this.metadataGateway = undefined;
  }

  private ownsMetadata(client: NewSessionMetadataClient, scope: ModelCatalogReadScope): boolean {
    const snapshot = this.pendingContext?.gateway.snapshot;
    return (
      this.metadataClient === client &&
      this.metadataGateway === this.pendingContext?.gateway &&
      this.metadataScope === scope &&
      snapshot?.phase === "connected" &&
      snapshot.client === client &&
      snapshot.hello === this.metadataHello &&
      snapshot.selfUser?.id === this.metadataIdentityId
    );
  }

  private bindMetadataSubscription(client: NewSessionMetadataClient, scope: ModelCatalogReadScope) {
    if (
      this.metadataScope &&
      this.metadataClient === client &&
      this.metadataGateway === this.pendingContext?.gateway &&
      this.metadataScope.agentId === scope.agentId &&
      this.metadataScope.authProfileId === scope.authProfileId &&
      this.metadataUnsubscribe
    ) {
      return this.metadataScope;
    }
    this.clearMetadataSubscription();
    this.metadataClient = client;
    this.metadataScope = scope;
    const gateway = this.pendingContext?.gateway;
    this.metadataGateway = gateway;
    this.defaultsObservation = this.pendingContext?.sessions.observeList(
      { agentId: scope.agentId, limit: 1 },
      (snapshot) => {
        if (!this.ownsMetadata(client, scope)) {
          return;
        }
        this.defaultsSnapshot = snapshot;
        this.restorePreference();
        this.notify();
      },
    );
    void this.defaultsObservation?.refresh().catch(() => undefined);
    this.metadataUnsubscribe = gateway
      ? subscribeModelCatalogChanges(
          gateway,
          () => {
            if (!this.ownsMetadata(client, scope)) {
              this.restoringPreference = false;
              this.draftAccount = undefined;
              this.clearMetadataSubscription();
              this.updateMetadataState({ catalog: [], hasSnapshot: false, status: "offline" });
              return;
            }
            void this.defaultsObservation?.refresh().catch(() => undefined);
            void this.startMetadataRequest(client, scope);
          },
          scope,
        )
      : undefined;
    return scope;
  }

  loadCatalogTargets(context: ApplicationContext | undefined, agentId: string, enabled: boolean) {
    this.catalogTargets.load(context, agentId, enabled);
  }

  private updateMetadataState(next: NewSessionMetadataState) {
    this.metadataState = next;
    this.notify();
  }

  private publishMetadataCatalog(result: ModelCatalogResult) {
    this.metadataState = {
      catalog: result.models,
      accountSelection: result.accountSelection,
      ...resolveModelCatalogState(result),
    };
    this.restorePreference();
    this.notify();
  }

  private startMetadataRequest(client: NewSessionMetadataClient, scope: ModelCatalogReadScope) {
    this.metadataRequest?.abort();
    const cached = peekModelCatalog(client, scope);
    if (cached) {
      this.metadataRequest = undefined;
      this.publishMetadataCatalog(cached);
      return Promise.resolve(cached);
    }
    const controller = new AbortController();
    this.metadataRequest = controller;
    const ownsRequest = () =>
      this.metadataRequest === controller && this.ownsMetadata(client, scope);
    this.updateMetadataState({
      ...this.metadataState,
      status: this.metadataState.hasSnapshot
        ? this.metadataState.status === "error"
          ? "error"
          : "ready"
        : "loading",
    });
    return loadModelCatalog(client, {
      ...scope,
      signal: controller.signal,
      timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
    }).then(
      (result) => {
        if (!ownsRequest()) {
          return undefined;
        }
        this.metadataRequest = undefined;
        this.publishMetadataCatalog(result);
        return result;
      },
      () => {
        if (!ownsRequest()) {
          return undefined;
        }
        this.metadataRequest = undefined;
        if (
          !this.draftAccount &&
          this.pendingSelectionGeneration === this.selectionGeneration &&
          (this.pendingPreference?.model || this.pendingPreference?.thinkingLevel)
        ) {
          this.selected = this.pendingPreference.model ?? "";
          this.thinkingLevel = this.pendingPreference.thinkingLevel ?? "";
        }
        this.restoringPreference = false;
        this.updateMetadataState({ ...this.metadataState, status: "error" });
        return undefined;
      },
    );
  }

  private selectDraftAccount(account: UserModelAccount, model: string): Promise<boolean> {
    const client = this.metadataClient;
    if (!client || !model) {
      return Promise.resolve(false);
    }
    this.selectionGeneration += 1;
    this.restoringPreference = false;
    this.draftAccount = { authProfileId: account.authProfileId, provider: account.provider, model };
    const requestedScope = { agentId: this.agentId, authProfileId: account.authProfileId };
    this.metadataState = {
      catalog: [],
      accountSelection: this.metadataState.accountSelection,
      hasSnapshot: false,
      status: "loading",
    };
    const scope = this.bindMetadataSubscription(client, requestedScope);
    return this.startMetadataRequest(client, scope).then(
      (result) => Boolean(result) && this.ownsMetadata(client, scope),
    );
  }

  private clearDraftAccount() {
    if (!this.draftAccount) {
      return;
    }
    this.draftAccount = undefined;
    this.clearMetadataSubscription();
    this.metadataState = { catalog: [], hasSnapshot: false, status: "idle" };
  }

  private retryPickerCatalogs() {
    const client = this.metadataClient;
    const scope = this.metadataScope;
    if (client && scope && this.ownsMetadata(client, scope) && this.defaultsSnapshot?.error) {
      void this.defaultsObservation?.refresh().catch(() => undefined);
    }
    if (!this.metadataRequest && client && scope) {
      void this.startMetadataRequest(client, scope);
    }
    this.catalogTargets.retry(client, this.agentId);
  }

  invalidate(resetSelection = false) {
    if (!resetSelection && this.metadataClient) {
      invalidateModelCatalogCache(this.metadataClient, this.metadataScope);
    }
    this.clearDraftAccount();
    this.clearMetadataSubscription();
    this.catalogTargets.clear();
    this.restoringPreference = false;
    if (resetSelection) {
      this.agentId = "";
      this.metadataClient = undefined;
      this.selected = "";
      this.contextWindow = "";
      this.thinkingLevel = "";
      this.fastMode = undefined;
      this.updateMetadataState({
        catalog: [],
        hasSnapshot: false,
        status: "idle",
      });
      return;
    }
    this.updateMetadataState({
      ...this.metadataState,
      status: this.metadataState.hasSnapshot ? this.metadataState.status : "idle",
    });
  }

  reset() {
    this.invalidate(true);
  }

  load(
    context: ApplicationContext | undefined,
    agentId: string,
    enabled: boolean,
    options: NewSessionMetadataLoadOptions = {},
  ) {
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.client;
    const normalizedAgentId = agentId.trim() ? normalizeAgentId(agentId) : "";
    this.pendingContext = context;
    if (
      this.agentId !== normalizedAgentId ||
      (this.metadataClient && this.metadataClient !== client) ||
      (this.metadataGateway && this.metadataGateway !== context?.gateway) ||
      this.metadataIdentityId !== snapshot?.selfUser?.id ||
      (this.metadataHello && this.metadataHello !== snapshot?.hello)
    ) {
      // Model preferences belong to the agent; an explicit account belongs to this connection.
      // Neither its availability nor an in-flight preview can cross an identity change.
      this.draftAccount = undefined;
      this.clearMetadataSubscription();
      if (this.agentId !== normalizedAgentId) {
        this.selected = "";
        this.contextWindow = "";
        this.thinkingLevel = "";
        this.fastMode = undefined;
      }
      this.agentId = normalizedAgentId;
      this.metadataClient = undefined;
      this.metadataState = {
        catalog: [],
        hasSnapshot: false,
        status: "idle",
      };
    }
    this.metadataIdentityId = snapshot?.selfUser?.id;
    this.metadataHello = snapshot?.hello;
    const selectionGeneration = this.selectionGeneration;
    if (!context || snapshot?.phase !== "connected" || !client || !normalizedAgentId || !enabled) {
      this.clearDraftAccount();
      this.clearMetadataSubscription();
      this.metadataClient = undefined;
      this.restoringPreference = false;
      if (context && snapshot?.phase !== "connected") {
        this.metadataState = {
          catalog: [],
          hasSnapshot: false,
          status: "offline",
        };
      }
      this.notify();
      return;
    }
    const scope = {
      agentId: normalizedAgentId,
      ...(this.draftAccount ? { authProfileId: this.draftAccount.authProfileId } : {}),
    };
    this.pendingPreference = options.preference;
    this.pendingSelectionGeneration = selectionGeneration;
    this.restoringPreference = Boolean(
      !this.draftAccount && (options.preference?.model || options.preference?.thinkingLevel),
    );
    const previousScope = this.metadataScope;
    const boundScope = this.bindMetadataSubscription(client, scope);
    const rebound = boundScope !== previousScope;
    if (this.metadataRequest) {
      this.notify();
      return;
    }
    // Render passes do not retry a failed read; publication events and picker opens do.
    if (!rebound && this.metadataState.status !== "idle") {
      if (
        this.metadataState.status === "ready" &&
        this.metadataState.hasSnapshot &&
        !this.draftAccount &&
        this.pendingSelectionGeneration === this.selectionGeneration
      ) {
        this.restorePreference();
      }
      return;
    }
    void this.startMetadataRequest(client, boundScope);
  }

  isRestoringPreference(): boolean {
    return this.restoringPreference;
  }

  modelUnavailableReason(): ModelCatalogEntry["unavailableReason"] {
    return this.metadataState.hasSnapshot && this.metadataState.status !== "offline"
      ? resolveChatModelUnavailableReason(
          this.effectiveModel || this.defaultsSnapshot?.result?.defaults.model,
          this.effectiveModel ? undefined : this.defaultsSnapshot?.result?.defaults.modelProvider,
          this.catalog,
        )
      : undefined;
  }

  modelSelectionBlockedReason(): string | undefined {
    if (this.draftAccount) {
      if (this.metadataState.status === "error") {
        return t("chat.modelControls.modelsUnavailable");
      }
      if (this.metadataRequest || !this.metadataState.hasSnapshot) {
        return t("chat.modelControls.loadingModels");
      }
      if (!this.accountSelectionReady()) {
        return (
          chatModelUnavailableMessage(this.modelUnavailableReason()) ??
          t("chat.modelControls.modelsUnavailable")
        );
      }
    }
    return chatModelUnavailableMessage(this.modelUnavailableReason());
  }

  modelForSubmission(): string {
    // Scope inspection also reads this intent while the submit gate waits for its preview.
    // The account suffix never enters the plain model preferences.
    return this.draftAccount
      ? `${this.draftAccount.model}@${this.draftAccount.authProfileId}`
      : this.selected;
  }

  accountSelectionReady(): boolean {
    if (!this.draftAccount) {
      return true;
    }
    const selection = this.metadataState.accountSelection;
    if (
      !this.metadataClient ||
      !this.metadataScope ||
      !this.ownsMetadata(this.metadataClient, this.metadataScope) ||
      this.metadataRequest ||
      this.metadataState.status !== "ready" ||
      selection?.kind !== "personal" ||
      selection.authProfileId !== this.draftAccount.authProfileId
    ) {
      return false;
    }
    const target = resolveDraftModelTarget(this.draftAccount.model, undefined, this.catalog);
    return target?.entry?.available === true && target.provider === this.draftAccount.provider;
  }

  private restorePreference() {
    if (this.defaultsSnapshot?.error) {
      this.restoringPreference = false;
      return;
    }
    if (
      !this.metadataState.hasSnapshot ||
      !this.defaultsSnapshot?.result ||
      this.draftAccount ||
      this.pendingSelectionGeneration !== this.selectionGeneration
    ) {
      return;
    }
    this.restoringPreference = false;
    const preference = this.pendingPreference;
    if (!preference) {
      return;
    }
    const selection = reconcileDraftModelSelection({
      model: preference.model ?? "",
      thinkingLevel: preference.thinkingLevel ?? "",
      defaults: this.defaultsSnapshot.result.defaults,
      catalog: this.catalog,
    });
    this.selected = selection.model;
    this.thinkingLevel = selection.thinkingLevel;
    if (selection.repaired) {
      this.onSelectionChange({ model: selection.model, thinkingLevel: selection.thinkingLevel });
    }
  }

  resolveAgentRuntime(): GatewayAgentRuntime | undefined {
    const defaults = this.defaultsSnapshot?.result?.defaults;
    let runtime: GatewayAgentRuntime | undefined;
    if (this.effectiveModel) {
      // Agent/default runtime metadata belongs to its default model. An explicit
      // model without per-model metadata is unknown, not an inherited runtime.
      runtime = resolveDraftModelTarget(this.effectiveModel, undefined, this.catalog)?.entry
        ?.agentRuntime;
    } else {
      const defaultTarget = resolveDraftModelTarget(
        defaults?.model,
        defaults?.modelProvider,
        this.catalog,
      );
      runtime = defaults?.agentRuntime ?? defaultTarget?.entry?.agentRuntime;
    }
    const runtimeId = runtime?.id.trim();
    // Default selectors need server-side model/provider policy before they are
    // concrete, so the UI must leave Cloud eligibility to the dispatch gate.
    if (!runtime || !runtimeId || runtimeId === "auto" || runtimeId === "default") {
      return undefined;
    }
    return runtimeId === runtime.id ? runtime : { ...runtime, id: runtimeId };
  }

  devicePlacementUnsupportedReason(): string | undefined {
    const runtime = this.resolveAgentRuntime();
    return runtime && !runtime.devicePlacement
      ? t("newSession.deviceRuntimeUnsupported")
      : undefined;
  }

  // Worker-turn runtimes rank automatic placement by free worker slots;
  // remote-exec runtimes select by eligible device order and must not be
  // described as least-busy. Unresolved (auto/default) runtimes fall back to
  // the worker-turn description, matching the server's default policy.
  autoPlacementSelectionMode(): "least-busy" | "eligible-order" {
    const runtime = this.resolveAgentRuntime();
    return runtime?.cloudPlacementExecutionMode === "remote-exec" ? "eligible-order" : "least-busy";
  }

  cloudRuntimeUnsupportedReason(profile?: DraftCloudProfile): string | undefined {
    const runtime = this.resolveAgentRuntime();
    if (runtime?.cloudPlacementSupported === false) {
      return t("newSession.cloudRuntimeUnsupported", { runtime: runtime.id });
    }
    return runtime &&
      profile &&
      runtime.cloudPlacementExecutionMode &&
      !draftCloudProfileSupportsExecutionMode(profile, runtime.cloudPlacementExecutionMode)
      ? t("newSession.cloudProfileRuntimeUnsupported", { runtime: runtime.id })
      : undefined;
  }

  render(options: { agentId: string; context: ApplicationContext | undefined; sending: boolean }) {
    const snapshot = options.context?.gateway.snapshot;
    const sessionKey = `new-session:${normalizeAgentId(options.agentId)}`;
    const sourceResult = this.defaultsSnapshot?.result ?? null;
    const agentDefaultsAvailable = sourceResult !== null;
    const defaultTarget = resolveDraftModelTarget(
      sourceResult?.defaults.model,
      sourceResult?.defaults.modelProvider,
      this.catalog,
    );
    const selectedTarget = resolveDraftModelTarget(this.effectiveModel, undefined, this.catalog);
    const client = snapshot?.client;
    const scope = this.metadataScope;
    const accountSelection = this.metadataState.accountSelection;
    const ownsSelection = () =>
      Boolean(
        client &&
        scope &&
        this.ownsMetadata(client, scope) &&
        this.metadataState.accountSelection === accountSelection,
      );
    const contextWindowTarget = selectedTarget?.entry ?? defaultTarget?.entry;
    const contextWindowDefault = contextWindowTarget?.contextWindowDefault;
    const selectedContextWindow = this.contextWindow || contextWindowDefault;
    const thinkingTarget = {
      ...resolveDraftThinkingTarget(selectedTarget),
      thinkingLevel: this.thinkingLevel || undefined,
    };
    const defaultThinkingProfile = resolveThinkingProfileForSession(
      resolveDraftThinkingTarget(defaultTarget),
      sourceResult?.defaults,
      this.catalog,
    );
    const thinkingDefaults = {
      modelProvider: defaultTarget?.provider ?? null,
      model: defaultTarget?.model ?? null,
      contextTokens: sourceResult?.defaults.contextTokens ?? null,
      agentRuntime: defaultThinkingProfile?.agentRuntime,
      thinkingLevels: defaultThinkingProfile?.thinkingLevels,
      thinkingDefault: defaultThinkingProfile?.thinkingDefault,
    };
    return renderChatModelControls({
      renderAccountSection: (model) =>
        renderChatModelAccountControl({
          owner: this,
          client,
          selection: ownsSelection() && snapshot?.selfUser ? accountSelection : undefined,
          model,
          disabled:
            options.sending || !model || !hasOperatorWriteAccess(snapshot?.hello?.auth ?? null),
          ownsSelection,
          onSelect: (account) =>
            ownsSelection() ? this.selectDraftAccount(account, model) : Promise.resolve(false),
          onAutomatic: this.draftAccount
            ? () => {
                if (ownsSelection()) {
                  this.selectionGeneration += 1;
                  this.clearDraftAccount();
                  this.load(options.context, options.agentId, true);
                }
              }
            : undefined,
          onManage: () => options.context?.navigate("profile"),
          onRequestUpdate: this.notify,
        }),
      activeRunId: null,
      connected: snapshot?.phase === "connected",
      gatewayAvailable: Boolean(snapshot?.client),
      loading: false,
      modelCatalog: this.catalog,
      modelCatalogState: {
        // Catalog rows and session defaults hydrate independently for this agent.
        hasSnapshot: agentDefaultsAvailable && this.metadataState.hasSnapshot,
        refreshFailed: this.metadataState.refreshFailed,
        pendingProviders: this.metadataState.pendingProviders,
        status: this.defaultsSnapshot?.error
          ? "error"
          : !agentDefaultsAvailable &&
              this.metadataState.status !== "error" &&
              this.metadataState.status !== "offline"
            ? "loading"
            : this.metadataState.status,
      },
      contextWindowTarget:
        contextWindowTarget?.contextWindows && selectedContextWindow
          ? {
              contextWindow: selectedContextWindow,
              contextWindows: contextWindowTarget.contextWindows,
              ...(contextWindowDefault ? { contextWindowDefault } : {}),
            }
          : undefined,
      fastModeTarget: {
        model: selectedTarget?.model ?? defaultTarget?.model,
        modelProvider: selectedTarget?.provider ?? defaultTarget?.provider ?? undefined,
        fastMode: this.fastMode,
        effectiveFastMode:
          this.fastMode ?? (selectedTarget?.entry ?? defaultTarget?.entry)?.effectiveFastMode,
      },
      modelOverrides: { [sessionKey]: this.effectiveModel || null },
      modelPickerTargetGroups: this.catalogTargets.groups(),
      modelSwitching: false,
      sending: options.sending,
      sessionKey,
      selectedSession: undefined,
      sessionsResult: agentDefaultsAvailable ? sourceResult : null,
      stream: null,
      thinkingDefaults,
      thinkingSession: thinkingTarget,
      onModelSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        const selection = reconcileDraftModelSelection({
          model: value,
          thinkingLevel: this.thinkingLevel,
          defaults: sourceResult?.defaults,
          catalog: this.catalog,
        });
        this.selected = selection.model;
        const target =
          resolveDraftModelTarget(selection.model, undefined, this.catalog) ?? defaultTarget;
        if (this.draftAccount && this.draftAccount.provider !== target?.provider) {
          this.clearDraftAccount();
          this.load(options.context, options.agentId, true);
        } else if (this.draftAccount && target) {
          this.draftAccount = {
            ...this.draftAccount,
            model: buildQualifiedChatModelValue(target.model, target.provider),
          };
        }
        this.contextWindow = "";
        this.thinkingLevel = selection.thinkingLevel;
        this.fastMode = isChatFastModeProviderSupported(
          (resolveDraftModelTarget(selection.model, undefined, this.catalog) ?? defaultTarget)
            ?.provider,
        )
          ? this.fastMode
          : undefined;
        this.onSelectionChange({ model: selection.model, thinkingLevel: this.thinkingLevel });
      },
      onModelPickerTargetSelect: (groupId, catalogId) => {
        if (groupId === "cliAgents") {
          this.onCatalogTargetSelect(catalogId);
        }
      },
      onModelPickerTargetRetry: (groupId) => {
        if (groupId === "cliAgents") {
          this.catalogTargets.retry(this.metadataClient, this.agentId);
        }
      },
      onThinkingSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        this.thinkingLevel = value;
        this.onSelectionChange({ model: this.selected, thinkingLevel: this.thinkingLevel });
      },
      onFastModeSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        this.fastMode = normalizeChatFastModeInput(value);
        this.notify();
      },
      onContextWindowSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        this.contextWindow = value;
        this.notify();
      },
      onModelSetup: () => options.context?.navigate("model-setup"),
      onModelPickerOpen: () => this.retryPickerCatalogs(),
      onRequestUpdate: this.notify,
    });
  }
}
