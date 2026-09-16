/** Runtime selection shared by cron preparation and individual fallback attempts. */
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSkillCollectionReviewRuntimeOverride } from "../skill-collection-review-runtime.js";
import { isCliProvider } from "./run-execution.runtime.js";

type CronRuntimeSelection = {
  config: OpenClawConfig;
  agentId: string;
  provider: string;
  modelId: string;
  sessionEntry?: SessionEntry;
  isSkillCollectionReview?: boolean;
};

export function resolveCronRuntimeOverride(params: CronRuntimeSelection): string | undefined {
  return params.isSkillCollectionReview
    ? resolveSkillCollectionReviewRuntimeOverride(params)
    : resolveSessionRuntimeOverrideForProvider({
        cfg: params.config,
        provider: params.provider,
        entry: params.sessionEntry,
      });
}

export function resolveCronCandidateExecution(params: CronRuntimeSelection) {
  const sessionRuntimeOverride = resolveCronRuntimeOverride(params);
  const executionProvider =
    (sessionRuntimeOverride && isCliProvider(sessionRuntimeOverride, params.config)
      ? sessionRuntimeOverride
      : undefined) ??
    (sessionRuntimeOverride
      ? params.provider
      : (resolveCliRuntimeExecutionProvider({
          provider: params.provider,
          cfg: params.config,
          agentId: params.agentId,
          modelId: params.modelId,
        }) ?? params.provider));
  return {
    sessionRuntimeOverride,
    executionProvider,
    cliExecution: isCliProvider(executionProvider, params.config),
  };
}
