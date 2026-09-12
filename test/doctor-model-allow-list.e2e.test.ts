import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

let instance: OpenClawTestInstance | undefined;

afterEach(async () => {
  await instance?.cleanup();
  instance = undefined;
});

describe("openclaw doctor allow-list consent through the CLI", () => {
  it.each([{ flags: [] }, { flags: ["--fix"] }, { flags: ["--yes"] }])(
    "offers a marked restriction without accepting it with $flags",
    async ({ flags }) => {
      instance = await createOpenClawTestInstance({
        name: "doctor-allow-list-consent",
        config: {
          meta: { migrations: { modelPolicyAllowlist: true } },
          cron: { enabled: false },
          agents: {
            ownership: "explicit",
            defaults: {
              model: "openai/fixture-primary",
              modelPolicy: { allow: ["openai/fixture-primary"] },
            },
            entries: { main: {} },
          },
          models: {
            mode: "replace",
            catalogRefresh: { enabled: false },
            providers: {
              openai: {
                api: "openai-completions",
                apiKey: "FAKE_ALLOW_LIST_CREDENTIAL",
                baseUrl: "http://127.0.0.1:9/v1",
                agentRuntime: { id: "openclaw" },
                models: [
                  { id: "fixture-primary", name: "Primary", contextWindow: 128000 },
                  { id: "fixture-other", name: "Other", contextWindow: 128000 },
                ],
              },
            },
          },
          plugins: { allow: ["openai"], entries: { openai: { enabled: true } } },
        },
      });
      await instance.startGateway();
      await instance.stopGateway();
      const before = await fs.readFile(instance.configPath, "utf8");

      const result = await instance.cli(["doctor", "--non-interactive", ...flags]);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("Model allow-list offer");
      expect(result.stdout).toContain("openai/*");
      const after = await fs.readFile(instance.configPath, "utf8");
      expect(JSON.parse(after)).toMatchObject({
        agents: { defaults: { modelPolicy: { allow: ["openai/fixture-primary"] } } },
      });
      if (flags.length === 0) {
        expect(after).toBe(before);
      }
    },
  );
});
