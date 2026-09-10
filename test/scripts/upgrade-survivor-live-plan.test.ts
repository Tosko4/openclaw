import { describe, expect, it } from "vitest";
import { resolveDockerE2ePlan } from "../../scripts/lib/docker-e2e-plan.mts";
import { planTargetedDockerLaneGroups } from "../../scripts/plan-targeted-docker-lane-groups.mjs";

function plan(selectedLaneNames: string[]) {
  return resolveDockerE2ePlan({
    includeOpenWebUI: false,
    liveMode: "all",
    liveRetries: 0,
    orderLanes: (lanes) => lanes,
    planReleaseAll: false,
    profile: "all",
    releaseChunk: "core",
    selectedLaneNames,
    timingStore: undefined,
    upgradeSurvivorBaselines:
      "2026.9.3,2026.9.2,2026.9.1,2026.8.2,2026.8.1,2026.7.1-2,2026.7.1-1,2026.7.1,2026.6.34,2026.6.33",
    upgradeSurvivorScenarios: "base,legacy-operator-state",
  }).plan;
}

describe("explicit paired OpenAI upgrade lane", () => {
  it("keeps hosted jobs baseline-bound without inheriting operator scenarios", () => {
    const groups = planTargetedDockerLaneGroups({
      lanes: "live-upgrade-survivor-openai",
      upgradeSurvivorBaselines: "2026.6.33 2026.7.1-2 2026.9.3",
      upgradeSurvivorScenarios: "base legacy-operator-state sqlite-volume",
    });
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.published_upgrade_survivor_baselines)).toEqual([
      "openclaw@2026.6.33",
      "openclaw@2026.7.1-2",
      "openclaw@2026.9.3",
    ]);
    expect(groups.every((group) => group.published_upgrade_survivor_scenarios === "base")).toBe(
      true,
    );
  });
  it("expands ten base-only upgrades with hosted API-key credentials and package companions", () => {
    const result = plan(["live-upgrade-survivor-openai"]);
    expect(result.lanes).toHaveLength(10);
    expect(result.credentials).toEqual(["openai"]);
    expect(result.imageKinds).toEqual(["bare"]);
    expect(result.needs.package).toBe(true);
    expect(result.needs.liveImage).toBe(false);
    expect(result.requiredPrepublishPluginPackages).toContain("@openclaw/codex");
    for (const lane of result.lanes) {
      expect(lane.live).toBe(true);
      expect(lane.name).not.toContain("legacy-operator-state");
      expect(lane.command).toContain("OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI=1");
      expect(lane.command).toContain("OPENCLAW_UPGRADE_SURVIVOR_SCENARIO=base");
      expect(lane.command).toContain("OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC='openclaw@");
      expect(lane.command).toContain('"$harness/scripts/e2e/upgrade-survivor-docker.sh"');
    }
    // Explicit opt-in cannot add paid live calls to the existing scheduled matrix.
    expect(
      plan([]).lanes.some((lane) => lane.name.startsWith("live-upgrade-survivor-openai")),
    ).toBe(false);
    const deterministic = plan(["published-upgrade-survivor"]);
    expect(deterministic.credentials).toEqual([]);
    expect(deterministic.lanes.some((lane) => lane.name.includes("legacy-operator-state"))).toBe(
      true,
    );
    expect(deterministic.lanes.every((lane) => !lane.live)).toBe(true);
  });
});
