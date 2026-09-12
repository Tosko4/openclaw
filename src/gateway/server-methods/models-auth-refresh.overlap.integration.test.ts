import { expect, it } from "vitest";
import { observeHeldGatewayWorkDrain } from "../server-held-work.test-support.js";
import { withAuthRefreshOverlap } from "./models-auth-refresh.overlap.test-support.js";

it("models.authRefresh keeps catalog publication held until an overlapping failed mutation releases it", async () => {
  await withAuthRefreshOverlap(async (fixture) => {
    expect((await fixture.list(true)).models.map((model) => model.id)).toEqual(["old-row"]);
    const firstHold = fixture.holdReconcile();
    const first = fixture.refresh();
    await firstHold.entered.promise;
    await fixture.save("new-key");
    const secondHold = fixture.holdReconcile();
    const second = fixture.refresh();
    const rejectedSecond = expect(second).rejects.toThrow("configuration application is failed");
    await secondHold.entered.promise;
    const catalog = fixture.holdCatalog();

    firstHold.release.resolve("reconcile");
    await expect(first).resolves.toEqual({ refreshed: true });
    expect((await fixture.list()).pendingProviders ?? []).not.toContain("overlap-fixture");
    expect(fixture.requests).not.toContain("Bearer new-key");

    secondHold.release.resolve("failed");
    await rejectedSecond;
    await catalog.entered;
    expect(
      fixture.requests.filter((authorization) => authorization === "Bearer new-key"),
    ).toHaveLength(1);
    catalog.release();
    await expect
      .poll(async () => (await fixture.list()).models.map((model) => model.id))
      .toEqual(["new-row"]);
  });
});

it("models.authRefresh releases a failed-only refresh without starting provider discovery", async () => {
  await withAuthRefreshOverlap(async (fixture) => {
    expect((await fixture.list(true)).models.map((model) => model.id)).toEqual(["old-row"]);
    const beforeFailure = [...fixture.requests];
    const failedHold = fixture.holdReconcile();
    const failed = fixture.refresh();
    const rejected = expect(failed).rejects.toThrow("configuration application is failed");
    await failedHold.entered.promise;
    expect((await fixture.list()).pendingProviders ?? []).not.toContain("overlap-fixture");
    expect(fixture.requests).toEqual(beforeFailure);
    failedHold.release.resolve("failed");
    await rejected;
    expect((await fixture.list()).models.map((model) => model.id)).toEqual(["old-row"]);
    expect(fixture.requests).toEqual(beforeFailure);

    const recoveryHold = fixture.holdReconcile();
    const recovered = fixture.refresh();
    await recoveryHold.entered.promise;
    await fixture.save("new-key");
    const catalog = fixture.holdCatalog();
    recoveryHold.release.resolve("reconcile");
    await expect(recovered).resolves.toEqual({ refreshed: true });
    await catalog.entered;
    expect(
      fixture.requests.filter((authorization) => authorization === "Bearer new-key"),
    ).toHaveLength(1);
    catalog.release();
    await expect
      .poll(async () => (await fixture.list()).models.map((model) => model.id))
      .toEqual(["new-row"]);
  });
});

it("models.authRefresh holds a same-auth-scope replacement owner while another agent remains usable", async () => {
  await withAuthRefreshOverlap(async (fixture) => {
    expect((await fixture.list(true)).models.map((model) => model.id)).toEqual(["old-row"]);
    expect((await fixture.list(true, "other")).models.map((model) => model.id)).toEqual([
      "other-row",
    ]);
    const hold = fixture.holdReconcile();
    const refresh = fixture.refresh();
    await hold.entered.promise;
    await fixture.save("new-key");
    const catalog = fixture.holdCatalog();

    const beforeReplacement = await fixture.client.request<{ hash: string }>("config.get", {});
    await fixture.client.request("config.patch", {
      baseHash: beforeReplacement.hash,
      raw: JSON.stringify({
        agents: { entries: { pro: { workspace: fixture.replacementWorkspace } } },
      }),
    });
    const replacement = await fixture.list();
    expect(replacement.models.map((model) => model.id)).not.toContain("new-row");
    expect(replacement.pendingProviders ?? []).not.toContain("overlap-fixture");
    expect(fixture.requests).not.toContain("Bearer new-key");
    expect((await fixture.list(true, "other")).models.map((model) => model.id)).toEqual([
      "other-row",
    ]);

    hold.release.resolve("reconcile");
    await expect(refresh).resolves.toEqual({ refreshed: true });
    await catalog.entered;
    expect(
      fixture.requests.filter((authorization) => authorization === "Bearer new-key"),
    ).toHaveLength(1);
    catalog.release();
    await expect
      .poll(async () => (await fixture.list()).models.map((model) => model.id))
      .toEqual(["new-row"]);
  });
});

it("models.authRefresh joins a retired refresh before Gateway close and preserves the next lifecycle's hold", async () => {
  const expectHeldWork = await observeHeldGatewayWorkDrain();
  await withAuthRefreshOverlap(async (fixture) => {
    expect((await fixture.list(true)).models.map((model) => model.id)).toEqual(["old-row"]);
    const retiredHold = fixture.holdReconcile();
    const retired = fixture.refresh();
    await retiredHold.entered.promise;
    const rejected = expect(retired).rejects.toThrow("gateway closed (1012): service restart");
    const closed = fixture.close();
    await expectHeldWork(closed);
    await rejected;
    retiredHold.release.resolve("applied");
    await expect(fixture.refreshCompletions[0]).resolves.toBeUndefined();
    await closed;
    await fixture.start();
    expect((await fixture.list(true)).models.map((model) => model.id)).toEqual(["old-row"]);
    const currentHold = fixture.holdReconcile();
    const current = fixture.refresh();
    await currentHold.entered.promise;
    await fixture.save("new-key");
    const catalog = fixture.holdCatalog();

    expect((await fixture.list()).pendingProviders ?? []).not.toContain("overlap-fixture");
    expect(fixture.requests).not.toContain("Bearer new-key");

    currentHold.release.resolve("reconcile");
    await expect(current).resolves.toEqual({ refreshed: true });
    await catalog.entered;
    expect(
      fixture.requests.filter((authorization) => authorization === "Bearer new-key"),
    ).toHaveLength(1);
    catalog.release();
    await expect
      .poll(async () => (await fixture.list()).models.map((model) => model.id))
      .toEqual(["new-row"]);
  });
});
