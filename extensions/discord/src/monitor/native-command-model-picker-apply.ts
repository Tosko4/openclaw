// Discord plugin module implements native command model picker apply behavior.
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listChatCommands,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import type { ButtonInteraction, StringSelectMenuInteraction } from "../internal/discord.js";
import type { DiscordLivePolicyReader } from "./live-policy.js";
import {
  recordDiscordModelPickerRecentModel,
  type DiscordModelPickerPreferenceScope,
} from "./model-picker-preferences.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import type { DiscordDispatchReplyFromConfig } from "./native-command.types.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];

type DiscordModelPickerApplyResult =
  | { status: "success"; effectiveModelRef: string; noticeMessage: string }
  | { status: "mismatch"; effectiveModelRef: string; noticeMessage: string }
  | { status: "rejected"; noticeMessage: string }
  | { status: "timeout"; noticeMessage: string }
  | { status: "failed"; noticeMessage: string };

function normalizeExpectedRuntime(value: string | undefined): string | undefined {
  const runtime = value?.trim();
  if (!runtime) {
    return undefined;
  }
  return runtime === "auto" || runtime === "default" ? "auto" : runtime;
}

export async function applyDiscordModelPickerSelection(params: {
  interaction: ButtonInteraction | StringSelectMenuInteraction;
  reset?: boolean;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
  cfg: OpenClawConfig;
  readPolicy?: DiscordLivePolicyReader;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  threadBindings: ThreadBindingManager;
  dispatchReplyFromConfig?: DiscordDispatchReplyFromConfig;
  route: ResolvedAgentRoute;
  resolvedModelRef: string;
  selectedRuntime?: string;
  preferenceScope: DiscordModelPickerPreferenceScope;
  settleMs: number;
  resolveCurrentModel: (route: ResolvedAgentRoute) => string;
  resolveCurrentRuntime: (route: ResolvedAgentRoute) => string;
}): Promise<DiscordModelPickerApplyResult> {
  const command =
    findCommandByNativeName("model", "discord") ??
    listChatCommands().find((entry) => entry.key === "model");
  if (!command) {
    return { status: "failed", noticeMessage: "Sorry, /model is unavailable right now." };
  }
  const commandArgs: CommandArgs = {
    values: { model: params.reset ? "default" : params.resolvedModelRef },
    raw: params.reset
      ? "default -s"
      : params.selectedRuntime
        ? `${params.resolvedModelRef} --runtime ${params.selectedRuntime}`
        : params.resolvedModelRef,
  };
  const prompt = buildCommandTextFromArgs(command, commandArgs);
  try {
    const dispatchResult = await withTimeout(
      params.dispatchCommandInteraction({
        readPolicy: params.readPolicy,
        interaction: params.interaction,
        prompt,
        command,
        commandArgs,
        cfg: params.cfg,
        discordConfig: params.discordConfig,
        accountId: params.accountId,
        sessionPrefix: params.sessionPrefix,
        preferFollowUp: true,
        threadBindings: params.threadBindings,
        suppressReplies: true,
        dispatchReplyFromConfig: params.dispatchReplyFromConfig,
        pluginCommandDispatch: { kind: "non-plugin" },
      }),
      12000,
    );
    if (!dispatchResult.accepted) {
      return {
        status: "rejected",
        noticeMessage: `❌ Failed to apply ${params.resolvedModelRef}. Try ${prompt} directly.`,
      };
    }
    const hiddenFinalReply = dispatchResult.hiddenFinalReply;
    const effectiveRoute = dispatchResult.effectiveRoute ?? params.route;
    if (params.settleMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, params.settleMs);
      });
    }

    const effectiveModelRef = params.resolveCurrentModel(effectiveRoute);
    const effectiveRuntime = params.resolveCurrentRuntime(effectiveRoute);
    const currentSelection = `Current selection: ${effectiveModelRef} with runtime ${effectiveRuntime}.`;
    if (hiddenFinalReply?.isError) {
      return {
        status: "rejected",
        noticeMessage: `${hiddenFinalReply.text?.trim()}\n${currentSelection}`,
      };
    }
    const expectedRuntime = normalizeExpectedRuntime(params.selectedRuntime);
    const resetEntry = params.reset
      ? getSessionEntry({
          storePath: resolveStorePath(params.cfg.session?.store, {
            agentId: effectiveRoute.agentId,
          }),
          sessionKey: effectiveRoute.sessionKey,
          readConsistency: "latest",
        })
      : undefined;
    const resetApplied =
      !params.reset ||
      (resetEntry?.modelOverrideSource === "default" &&
        resetEntry.modelOverride === undefined &&
        resetEntry.providerOverride === undefined);
    const verified =
      resetApplied &&
      effectiveModelRef === params.resolvedModelRef &&
      (expectedRuntime === undefined || effectiveRuntime === expectedRuntime);
    if (verified && !params.reset) {
      await recordDiscordModelPickerRecentModel({
        scope: params.preferenceScope,
        modelRef: params.resolvedModelRef,
        limit: 5,
      }).catch(() => undefined);
    }

    return verified
      ? {
          status: "success",
          effectiveModelRef,
          noticeMessage:
            hiddenFinalReply?.text?.trim() ||
            (params.reset
              ? `✅ Model reset to default (${params.resolvedModelRef}).`
              : `✅ Model set to ${params.resolvedModelRef}.`),
        }
      : {
          status: "mismatch",
          effectiveModelRef,
          noticeMessage: params.reset
            ? `⚠️ Default reset was not confirmed. ${currentSelection}`
            : `⚠️ Tried to set ${params.resolvedModelRef}${expectedRuntime ? ` with runtime ${expectedRuntime}` : ""}, but current selection is ${effectiveModelRef} with runtime ${effectiveRuntime}.`,
        };
  } catch (error) {
    if (error instanceof Error && error.message === "timeout") {
      return {
        status: "timeout",
        noticeMessage: `⏳ Model change to ${params.resolvedModelRef} is still processing. Check /status in a few seconds.`,
      };
    }
    return {
      status: "failed",
      noticeMessage: `❌ Failed to apply ${params.resolvedModelRef}. Try ${prompt} directly.`,
    };
  }
}
