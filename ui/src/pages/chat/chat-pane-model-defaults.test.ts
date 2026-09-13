/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-model-defaults.test/"} */

import { expectDefined } from "@openclaw/normalization-core";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createNativeChatDrafts } from "../../app/native-bridge.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { ControlUiPluginRuntime } from "../../plugins/control-ui-runtime.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createInitializationContext, createSessionContext } from "./chat-pane.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import "./chat-pane.ts";

describe("mounted Chat pane model defaults", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it.each(["agent:work:thread", "global"])(
    "keeps Work Default and concrete model intent after a Main roster publication for %s",
    async (sessionKey) => {
      const lateMain = createDeferred<SessionsListResult>();
      let holdMain = false;
      let model = "pinned-model";
      let updatedAt = 10;
      let modelOverrideSource: GatewaySessionRow["modelOverrideSource"] = "user";
      const workRow = (): GatewaySessionRow => ({
        key: sessionKey,
        agentId: "work",
        kind: sessionKey === "global" ? "global" : "direct",
        sessionId: "work-session",
        updatedAt,
        modelProvider: "example",
        model,
        modelOverrideSource,
      });
      const workDefaults: SessionsListResult["defaults"] = {
        modelProvider: "example",
        model: "work-model",
        contextTokens: null,
      };
      const main = sessionsResult(
        [{ key: "agent:main:thread", agentId: "main", kind: "direct", updatedAt: 20 }],
        20,
      );
      main.defaults = { modelProvider: "example", model: "main-model", contextTokens: null };
      const request = createGatewayRequestMock((method, params) => {
        const input = asNullableRecord(params);
        switch (method) {
          case "sessions.list":
            return input?.agentId === "work"
              ? { ...sessionsResult([workRow()], updatedAt), defaults: workDefaults }
              : holdMain
                ? lateMain.promise
                : main;
          case "chat.startup":
          case "chat.history":
            return { messages: [], sessionInfo: workRow(), defaults: workDefaults };
          case "models.list":
            return {
              models: [
                { provider: "example", id: "work-model", name: "Work Model" },
                { provider: "example", id: "main-model", name: "Main Model" },
                { provider: "example", id: "pinned-model", name: "Pinned Model" },
                { provider: "example", id: "external-model", name: "External Model" },
              ],
            };
          case "sessions.patch":
            if (input?.model === null || input?.model === "example/main-model") {
              model = input.model === null ? "work-model" : "main-model";
              modelOverrideSource = input.model === null ? null : "user";
            }
            updatedAt += 1;
            return { ok: true, key: sessionKey, entry: workRow() };
          case "agents.list":
            return {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                {
                  id: "main",
                  name: "Main",
                  kind: "agent",
                  model: { primary: "example/main-model" },
                },
                {
                  id: "work",
                  name: "Work",
                  kind: "agent",
                  model: { primary: "example/pinned-model" },
                },
              ],
            };
          case "agent.identity.get":
            return { agentId: "work", name: "Work" };
          case "sessions.branches.list":
            return { branches: [] };
          case "chat.metadata":
          case "commands.list":
            return { commands: [] };
          default:
            return {};
        }
      });
      const client = createTestGatewayClient(request);
      const initial = createInitializationContext();
      const shared = createSessionContext(client);
      shared.publishGatewaySnapshot({
        ...shared.gateway.snapshot,
        hello: gatewayHelloForMethods([
          "chat.startup",
          "chat.history",
          "chat.metadata",
          "models.list",
          "sessions.list",
          "sessions.patch",
        ]),
      });
      const plugins = new ControlUiPluginRuntime(() => context);
      const context: ApplicationContext = {
        ...initial,
        ...shared,
        config: createApplicationConfigCapability({ resourceBasePath: "" }),
        placementStartup: initial.placementStartup,
        nativeChatDrafts: createNativeChatDrafts(),
        plugins,
      };
      const host = createApplicationContextProvider(context);
      const pane = document.createElement("openclaw-chat-pane");
      pane.sessionKey = sessionKey;
      pane.agentId = "work";
      pane.paneId = "work-defaults";
      pane.active = true;
      const option = (value: string) =>
        expectDefined(
          pane.querySelector<HTMLButtonElement>(`[data-chat-model-option="${value}"]`),
          `model option ${value}`,
        );
      const trigger = () =>
        expectDefined(
          pane.querySelector<HTMLElement>('[data-chat-model-select="true"]'),
          "model picker trigger",
        );
      try {
        await context.sessions.refresh({ agentId: "work" });
        host.append(pane);
        document.body.append(host);
        await vi.waitFor(() => {
          expect(option("example/work-model").dataset.chatModelDefault).toBe("true");
          expect(option("example/pinned-model").getAttribute("aria-selected")).toBe("true");
        });

        holdMain = true;
        const refreshingMain = context.sessions.refresh({ agentId: "main" });
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith(
            "sessions.list",
            expect.objectContaining({ agentId: "main" }),
          ),
        );
        holdMain = false;
        lateMain.resolve(main);
        await refreshingMain;
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
        await pane.updateComplete;
        expect(context.sessions.state.agentId).toBe("main");
        expect(option("example/work-model").dataset.chatModelDefault).toBe("true");
        expect(option("example/main-model").hasAttribute("data-chat-model-default")).toBe(false);

        updatedAt = 30;
        shared.publishGatewayEvent({
          type: "event",
          event: "sessions.changed",
          payload: {
            sessionKey,
            agentId: "work",
            reason: "patch",
            updatedAt: 30,
            modelProvider: "example",
            model: "external-model",
            modelOverrideSource: "user",
          },
        });
        await vi.waitFor(() => expect(trigger().textContent).toContain("External Model"));
        expect(option("example/work-model").dataset.chatModelDefault).toBe("true");
        expect(context.sessions.state.agentId).toBe("main");
        expect(context.sessions.state.result?.defaults.model).toBe("main-model");

        trigger().click();
        await pane.updateComplete;
        option("example/main-model").click();
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith(
            "sessions.patch",
            expect.objectContaining({ key: sessionKey, model: "example/main-model" }),
          ),
        );
        await vi.waitFor(() => expect(option("example/work-model").disabled).toBe(false));
        trigger().click();
        await pane.updateComplete;
        option("example/work-model").click();
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith(
            "sessions.patch",
            expect.objectContaining({ key: sessionKey, model: null }),
          ),
        );
        await vi.waitFor(() => {
          expect(option("example/work-model").disabled).toBe(false);
          expect(option("example/work-model").getAttribute("aria-selected")).toBe("true");
        });

        await context.sessions.refresh({ agentId: "main" });
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
        await pane.updateComplete;
        expect(context.sessions.state.agentId).toBe("main");
        shared.publishGatewayEvent({
          type: "event",
          event: "sessions.changed",
          payload: {
            sessionKey,
            agentId: "work",
            sessionId: "work-session",
            reason: "patch",
            updatedAt: 40,
            modelProvider: "example",
            model: "external-model",
            modelOverrideSource: "user",
          },
        });
        await vi.waitFor(() => expect(trigger().textContent).toContain("External Model"));
        shared.publishGatewayEvent({
          type: "event",
          event: "sessions.changed",
          payload: {
            sessionKey,
            agentId: "work",
            sessionId: "work-session",
            reason: "delete",
            updatedAt: 50,
          },
        });
        expect(context.sessions.deletionState(sessionKey, "work", "work-session")).toBe(
          "confirmed",
        );
        await vi.waitFor(() => expect(trigger().textContent).toContain("Work Model"));
        expect(trigger().textContent).not.toContain("External Model");
        expect(context.sessions.state.agentId).toBe("main");
        expect(context.sessions.state.result?.defaults.model).toBe("main-model");
      } finally {
        lateMain.resolve(main);
        host.remove();
        plugins.dispose();
        context.nativeChatDrafts.dispose();
        await vi.dynamicImportSettled();
      }
    },
  );
});
