import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { removeAuthProfilesAcrossOwnerStores } from "./profiles.js";
import { upsertAuthProfileWithLockOrThrow } from "./upsert-with-lock.js";

it.each(["profile", "provider"] as const)(
  "removes a main-agent %s after one config cleanup without removing unrelated credentials",
  async (scope) => {
    await withOpenClawTestState(
      { label: "main-auth-removal", layout: "state-only" },
      async (state) => {
        const accountA = createApiKeyCredential("fixture", "account-A");
        const accountB = createApiKeyCredential("fixture", "account-B");
        const unrelated = createApiKeyCredential("other-fixture", "unrelated-account");
        await state.writeAuthProfiles({
          version: 1,
          profiles: { "fixture:A": accountA, "fixture:B": accountB, "other:saved": unrelated },
        });
        const profileIds = scope === "profile" ? ["fixture:B"] : ["fixture:A", "fixture:B"];
        const beforeRemove = vi.fn(async () => {});
        const onIncomplete = vi.fn(async () => {});

        const removed = await removeAuthProfilesAcrossOwnerStores({
          agentDir: state.agentDir(),
          profileIds,
          ...(scope === "provider" ? { provider: "fixture" } : {}),
          beforeRemove,
          onIncomplete,
        });

        expect(removed).toBe(true);
        expect(beforeRemove).toHaveBeenCalledExactlyOnceWith(profileIds);
        expect(onIncomplete).not.toHaveBeenCalled();
        expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toEqual(
          scope === "profile"
            ? { "fixture:A": accountA, "other:saved": unrelated }
            : { "other:saved": unrelated },
        );
        expect(loadPersistedAuthProfileStore()?.profiles).toEqual(
          scope === "profile"
            ? { "fixture:A": accountA, "other:saved": unrelated }
            : { "other:saved": unrelated },
        );
      },
    );
  },
);

it("keeps the shared credential when removing an agent-local override", async () => {
  await withOpenClawTestState(
    { label: "local-auth-removal", layout: "state-only" },
    async (state) => {
      const shared = createApiKeyCredential("fixture", "shared-account");
      const local = createApiKeyCredential("fixture", "local-account");
      await state.writeAuthProfiles({ version: 1, profiles: { "fixture:saved": shared } });
      await state.writeAuthProfiles({ version: 1, profiles: { "fixture:saved": local } }, "worker");
      const beforeRemove = vi.fn(async () => {});

      await expect(
        removeAuthProfilesAcrossOwnerStores({
          agentDir: state.agentDir("worker"),
          profileIds: ["fixture:saved"],
          beforeRemove,
        }),
      ).resolves.toBe(true);

      expect(beforeRemove).toHaveBeenCalledExactlyOnceWith(["fixture:saved"]);
      expect(loadPersistedAuthProfileStore(state.agentDir("worker"))?.profiles).toEqual({});
      expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toEqual({
        "fixture:saved": shared,
      });
    },
  );
});

it("preserves a replacement account saved while removal waits for config cleanup", async () => {
  await withOpenClawTestState(
    { label: "auth-removal-replacement", layout: "state-only" },
    async (state) => {
      const original = createApiKeyCredential("fixture", "original-account");
      const replacement = createApiKeyCredential("fixture", "replacement-account");
      await state.writeAuthProfiles({ version: 1, profiles: { "fixture:saved": original } });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const beforeRemove = vi.fn(async () => {
        entered.resolve();
        await release.promise;
      });
      const onIncomplete = vi.fn(async () => {});
      const removing = removeAuthProfilesAcrossOwnerStores({
        agentDir: state.agentDir(),
        profileIds: ["fixture:saved"],
        beforeRemove,
        onIncomplete,
      });
      try {
        await entered.promise;
        await upsertAuthProfileWithLockOrThrow({
          agentDir: state.agentDir(),
          profileId: "fixture:saved",
          credential: replacement,
        });
        release.resolve();

        await expect(removing).resolves.toBe(false);
        expect(beforeRemove).toHaveBeenCalledExactlyOnceWith(["fixture:saved"]);
        expect(onIncomplete).toHaveBeenCalledExactlyOnceWith(
          new Map([["fixture:saved", replacement]]),
        );
        expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toEqual({
          "fixture:saved": replacement,
        });
      } finally {
        release.resolve();
        await removing;
      }
    },
  );
});
