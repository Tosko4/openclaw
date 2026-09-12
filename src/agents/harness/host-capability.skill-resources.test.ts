import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { getTextContent } from "../test-helpers/agent-tools-fs-helpers.js";
import { createAgentToolsSandboxContext } from "../test-helpers/agent-tools-sandbox-context.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

const hosts: Array<Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>> = [];
const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    for (const host of hosts.splice(0)) {
      host.closeHost();
      host.closeAdmission();
    }
    vi.unstubAllEnvs();
    cleanup();
  }),
);
const unavailableSnapshot: SkillSnapshot = {
  prompt: "",
  skills: [{ name: "unavailable-host-pin" }],
  resolvedSkills: [],
  librarySelections: [
    {
      skillId: "11111111-1111-4111-8111-111111111111",
      revision: "f".repeat(64),
      name: "unavailable-host-pin",
      ownerProfileId: null,
    },
  ],
};

async function setup(runId: string) {
  const root = temps.make("host-skill-resources-");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(workspaceDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: workspaceDir } },
    plugins: { enabled: false },
    tools: { fs: { workspaceOnly: true } },
  };
  return { runId, workspaceDir, config, skillsSnapshot: unavailableSnapshot };
}

describe("host skill resource construction boundaries", () => {
  it("does not resolve host pins for a surface without filesystem tools", async () => {
    const attempt = await setup("host-no-fs");
    const host = await createAdmittedHostCapabilityTestFixture(attempt);
    hosts.push(host);
    const tools = host.hostCapabilities.createToolSurface!({
      config: attempt.config,
      workspaceDir: attempt.workspaceDir,
      includeCoreTools: false,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    });
    expect(tools).toEqual([]);
  });

  it.each([false, true])(
    "keeps sandbox reads independent of host pins (pre-resolved: %s)",
    async (preResolved) => {
      const attempt = await setup("host-sandbox");
      await fs.writeFile(path.join(attempt.workspaceDir, "local.txt"), "sandbox content");
      const sandbox = createAgentToolsSandboxContext({
        workspaceDir: attempt.workspaceDir,
        agentWorkspaceDir: attempt.workspaceDir,
        workspaceAccess: "rw",
        fsBridge: createHostSandboxFsBridge(attempt.workspaceDir),
        tools: { allow: [], deny: [] },
      });
      const host = await createAdmittedHostCapabilityTestFixture({
        ...attempt,
        ...(preResolved ? { sandbox } : {}),
      });
      hosts.push(host);
      const tools = host.hostCapabilities.createToolSurface!({
        workspaceDir: attempt.workspaceDir,
        config: attempt.config,
        sandbox,
      });
      const read = tools.find((tool) => tool.name === "read");
      expect(read).toBeDefined();
      expect(getTextContent(await read!.execute("sandbox-read", { path: "local.txt" }))).toBe(
        "sandbox content",
      );
    },
  );
});
