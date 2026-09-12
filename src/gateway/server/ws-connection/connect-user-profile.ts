import { resolveHostAccountName } from "../../../infra/host-account-name.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
  getUserProfileDisplay,
} from "../../../state/user-profiles.js";
import type { GatewayAuthResult } from "../../auth.js";
import {
  createAuthenticatedGitHubIdentitySync,
  type AuthenticatedGitHubIdentity,
  type AuthenticatedGitHubIdentitySync,
} from "../../github-user-identity.js";

export function prepareGatewayConnectGitHubIdentity(
  params: Parameters<typeof createAuthenticatedGitHubIdentitySync>[0],
) {
  const prepared: {
    resolve: AuthenticatedGitHubIdentitySync | undefined;
    identity?: AuthenticatedGitHubIdentity;
  } = { resolve: undefined };
  const sync = createAuthenticatedGitHubIdentitySync(params);
  if (sync) {
    prepared.resolve = async () => {
      const result = await sync();
      // Keep the verified binding together even if profile display refresh follows a merge.
      prepared.identity = {
        profileId: result.profileId,
        accountId: result.githubIdentity.accountId,
        login: result.githubIdentity.login,
      };
      return result;
    };
  }
  return prepared;
}

export function resolveAuthenticatedProfile(profileId: string, updatedAt: number) {
  const { id, displayName, avatarRevision, hasAvatar } = getUserProfileDisplay(profileId);
  return { profileId: id, displayName, avatarRevision, hasAvatar, updatedAt };
}

export async function resolveGatewayConnectUserProfile(params: {
  ownerProfileExpected: boolean;
  authenticatedUserId: string | undefined;
  authResult: GatewayAuthResult;
  resolveAuthenticatedGitHubIdentity: ReturnType<typeof createAuthenticatedGitHubIdentitySync>;
}) {
  const profile = params.ownerProfileExpected
    ? ensureGatewayOwnerProfile(await resolveHostAccountName())
    : params.resolveAuthenticatedGitHubIdentity
      ? await params.resolveAuthenticatedGitHubIdentity()
      : params.authResult.tailscaleIdentity
        ? ensureProfileForTailscaleIdentity(params.authResult.tailscaleIdentity)
        : ensureProfileForEmail(params.authenticatedUserId!);
  const profileId = "profileId" in profile ? profile.profileId : profile.id;
  return resolveAuthenticatedProfile(profileId, profile.updatedAt);
}
