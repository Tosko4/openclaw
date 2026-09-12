import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  normalizeOperatorApprovalDecisionActor,
  type OperatorApprovalDecisionActor,
} from "./operator-approval-store.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import { isSyntheticGatewayCaller } from "./server-methods/gateway-personal-caller.js";

export function resolveOperatorApprovalDecisionActor(
  client: GatewayClient | null,
): OperatorApprovalDecisionActor | undefined {
  if (
    !client?.authenticatedUserId ||
    (client.connect.role !== undefined && client.connect.role !== "operator") ||
    isSyntheticGatewayCaller(client) ||
    client.internal?.approvalRuntime ||
    client.internal?.operatorRoleActor?.kind === "system"
  ) {
    return undefined;
  }
  const github = client.authenticatedGitHubIdentity;
  const profileId = github?.profileId ?? client.authenticatedUserProfile?.profileId;
  // Shared gateway credentials get an owner profile, not an authenticated person.
  if (profileId === GATEWAY_OWNER_PROFILE_ID) {
    return undefined;
  }
  return normalizeOperatorApprovalDecisionActor(
    profileId,
    github && Number.isSafeInteger(github.accountId) && github.accountId > 0
      ? github.login
      : undefined,
  );
}
