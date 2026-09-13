import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings config publication recovery" });
const config = {
  gateway: { mode: "local", auth: { mode: "token", token: "__OPENCLAW_REDACTED__" } },
  agents: { defaults: { workspace: "/workspace" } },
  plugins: { enabled: false },
  logging: { level: "info" },
  messages: { responsePrefix: "initial" },
};
const snapshot = {
  exists: true,
  valid: true,
  config,
  raw: JSON.stringify(config),
  hash: "initial",
};
const configPath = "/settings/openclaw.json";
const recoveryBackupPath = `${configPath}.bak`;

suite.define(() => {
  it.each(["unknown", "not-restored", "restored"])(
    "Settings config.set preserves the full draft after partial publication (%s)",
    async (rollbackStatus) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": snapshot,
            "config.schema": {
              schema: {
                type: "object",
                properties: {
                  messages: {
                    type: "object",
                    properties: {
                      responsePrefix: { type: "string", title: "Outbound Response Prefix" },
                    },
                  },
                },
              },
              uiHints: { "messages.responsePrefix": { advanced: false } },
              version: "test",
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/communications`);
        const prefix = page.getByRole("textbox", { name: "Outbound Response Prefix" });
        await prefix.waitFor();
        await gateway.deferNext("config.set");
        await prefix.fill("retained draft");
        await prefix.press("Tab");
        await gateway.waitForRequest("config.set");
        const message = `Config publication failed after removing ${configPath}: included config changed since last load. Restoration: ${rollbackStatus}. Inspect recovery backups at ${recoveryBackupPath}.`;
        await gateway.rejectDeferred("config.set", {
          code: "UNAVAILABLE",
          message,
          details: { publication: "partial", rollbackStatus, configPath, recoveryBackupPath },
        });
        const indicator = page.locator("openclaw-settings-save-indicator");
        await expect
          .poll(() => indicator.textContent())
          .toContain(rollbackStatus === "restored" ? "Save failed" : "Your draft is kept");
        expect(await indicator.getByRole("button", { name: "Reload" }).count()).toBe(0);
        if (rollbackStatus !== "restored") {
          await gateway.setMethodResponse("config.get", {
            ...snapshot,
            exists: false,
            config: {},
            raw: null,
            hash: "missing",
          });
          await prefix.fill("later draft");
          await prefix.press("Tab");
          // Exceed the registered Settings autosave debounce before checking absence.
          await page.waitForTimeout(1200);
          expect(await gateway.getRequests("config.set")).toHaveLength(1);
          expect(await prefix.inputValue()).toBe("later draft");
          expect(await indicator.textContent()).toContain(configPath);
          expect(await indicator.textContent()).toContain(recoveryBackupPath);
          expect(await indicator.getByRole("button").count()).toBe(0);
        } else {
          await gateway.deferNext("config.set");
          await indicator.getByRole("button", { name: "Retry" }).click();
          const retried = await gateway.waitForRequest("config.set", { after: 1 });
          expect(retried.params).toEqual(expect.objectContaining({ raw: expect.any(String) }));
          const { raw } = retried.params as { raw: string };
          expect(JSON.parse(raw)).toEqual({
            ...config,
            messages: { responsePrefix: "retained draft" },
          });
          await gateway.resolveDeferred("config.set");
          await expect.poll(() => indicator.textContent()).toContain("Apply changes");
          await page.reload();
          await expect.poll(() => prefix.inputValue()).toBe("retained draft");
        }
      });
    },
  );
});
