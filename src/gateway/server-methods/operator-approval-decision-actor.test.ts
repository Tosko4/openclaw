import { describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { resolveOperatorApprovalDecisionActor } from "../operator-approval-decision-actor.js";
import type { GatewayClient } from "./client-types.js";

function client(): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        displayName: "Not an identity",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
    },
    authenticatedUserId: "reviewer@example.test",
    authenticatedUserProfile: {
      profileId: "person-a",
      displayName: "Not an identity",
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

describe("authenticated approval decision actor", () => {
  it("distinguishes people using the same client without copying names or emails", () => {
    const first = client();
    const second = client();
    second.authenticatedUserProfile!.profileId = "person-b";
    expect(resolveOperatorApprovalDecisionActor(first)).toEqual({ profileId: "person-a" });
    expect(resolveOperatorApprovalDecisionActor(second)).toEqual({ profileId: "person-b" });
  });

  it("keeps a prepared GitHub binding together across profile refresh, without awaiting sync", () => {
    const reviewer = client();
    reviewer.authenticatedUserIsTailscaleProvider = true;
    reviewer.authenticatedGitHubIdentity = {
      profileId: "person-a",
      accountId: 101,
      login: "reviewer-a",
    };
    reviewer.authenticatedGitHubIdentitySync = vi.fn();
    reviewer.authenticatedUserProfile!.profileId = "person-b";
    expect(resolveOperatorApprovalDecisionActor(reviewer)).toEqual({
      profileId: "person-a",
      githubLogin: "reviewer-a",
    });
    expect(reviewer.authenticatedGitHubIdentitySync).not.toHaveBeenCalled();
  });

  it.each<Partial<GatewayClient>>([
    { authenticatedUserId: undefined },
    { authenticatedUserProfile: undefined },
    { internal: { syntheticClient: true } },
    { internal: { agentToolCaller: { agentId: "main", sessionKey: "agent:main:test" } } },
    { internal: { approvalRuntime: true } },
    { internal: { operatorRoleActor: { kind: "system" } } },
    {
      authenticatedUserProfile: {
        profileId: GATEWAY_OWNER_PROFILE_ID,
        displayName: null,
        hasAvatar: false,
        updatedAt: 1,
      },
    },
  ])("does not turn shared or internal clients into people: %j", (overrides) => {
    expect(resolveOperatorApprovalDecisionActor({ ...client(), ...overrides })).toBeUndefined();
  });

  it("ignores request-supplied actor fields and invalid optional account metadata", () => {
    const reviewer = client();
    Object.assign(reviewer.connect, {
      decisionActor: { profileId: "forged", githubLogin: "forged" },
    });
    reviewer.authenticatedGitHubIdentity = {
      profileId: "person-a",
      accountId: -1,
      login: "forged",
    };
    expect(resolveOperatorApprovalDecisionActor(reviewer)).toEqual({ profileId: "person-a" });
  });

  it("does not attribute ambient agent-tool dispatch to its retained human client", async () => {
    await withGatewayToolCallerIdentity({ agentId: "main", sessionKey: "agent:main:test" }, () => {
      expect(resolveOperatorApprovalDecisionActor(client())).toBeUndefined();
    });
  });
});
