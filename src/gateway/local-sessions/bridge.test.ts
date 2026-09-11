import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { encodeLocalSessionFrame } from "../../sessions/local-session-source-protocol.js";
import type { NodeSession } from "../node-registry.js";
import type { LiveThread } from "./bridge-mirror.js";
import { LocalSessionBridgeRuntime } from "./bridge.runtime.js";

const fixtures = vi.hoisted(() => ({
  source: {
    pluginId: "anthropic",
    sourceId: "claude",
    label: "Claude Code",
    command: "anthropic.claude.localSessions.source.v1",
  },
  enrollment: {
    enrollmentId: "enrollment-1",
    deviceId: "device-1",
    pluginId: "anthropic",
    sourceId: "claude",
    agentId: "main",
    ownerProfileId: "owner-1",
    ownerLabel: "Owner",
    state: "active",
  },
  openDuplex: vi.fn(),
  ensureThread: vi.fn(),
}));

vi.mock("../server-plugins.js", () => ({
  createGatewayNodesRuntime: () => ({ openDuplex: fixtures.openDuplex }),
}));
vi.mock("./bridge.js", () => ({
  listRegisteredLocalSessionSources: () => [fixtures.source],
}));
vi.mock("../../state/local-session-enrollments.js", () => ({
  listLocalSessionEnrollments: () => [fixtures.enrollment],
  listLocalSessionExclusions: () => [],
}));
vi.mock("../../config/sessions/session-local-store.js", () => ({
  listLocalSessionMirrorCheckpoints: () => [],
}));
vi.mock("./bridge-mirror.js", () => ({
  ensureLocalSessionThread: fixtures.ensureThread,
}));

describe("local session availability", () => {
  it("distinguishes an ended thread and source disconnect from an offline device", async () => {
    type Channel = Awaited<ReturnType<PluginRuntime["nodes"]["openDuplex"]>>;
    const listening = createDeferred<Parameters<Channel["onMessage"]>[0]>();
    const closed = createDeferred();
    const channel: Channel = {
      send: async () => {},
      onMessage: (listener) => {
        listening.resolve(listener);
        return () => {};
      },
      closed: closed.promise,
      close: () => closed.resolve(),
    };
    fixtures.openDuplex.mockResolvedValue(channel);
    const thread: LiveThread = {
      sessionKey: "agent:main:local:claude:device-1:owner-1:thread-1",
      sessionId: "session-1",
      agentId: "main",
      storePath: "/unused/agent.sqlite",
      threadId: "thread-1",
      state: "idle",
      canInput: true,
      acceptedSeq: 0,
      appendChain: Promise.resolve(),
    };
    fixtures.ensureThread.mockResolvedValue(thread);
    const entry: SessionEntry = {
      sessionId: thread.sessionId,
      updatedAt: 0,
      localSource: {
        pluginId: "anthropic",
        sourceId: "claude",
        deviceId: "device-1",
        threadId: thread.threadId,
        enrollmentId: "enrollment-1",
      },
    };
    const lifetime = new AbortController();
    const bridge = new LocalSessionBridgeRuntime({
      resolveGatewayContext: () => undefined,
      getRuntimeConfig: () => ({}),
      signal: lifetime.signal,
    });
    try {
      bridge.onNodeConnected({
        nodeId: "device-1",
        connId: "conn-1",
        // The node transport is supplied by the fake duplex, so no WebSocket is read.
        client: {} as NodeSession["client"],
        declaredCaps: [],
        caps: [],
        declaredCommands: [fixtures.source.command],
        commands: [fixtures.source.command],
        declaredNodePluginTools: [],
        nodePluginTools: [],
        nodeSkills: [],
        connectedAtMs: 0,
      });
      const receive = await listening.promise;
      await receive(
        encodeLocalSessionFrame({
          type: "hello",
          protocol: 1,
          sourceId: "claude",
          inputModes: ["followup"],
        }),
      );
      await receive(
        encodeLocalSessionFrame({
          type: "session",
          threadId: thread.threadId,
          state: "idle",
          canInput: true,
        }),
      );
      expect(bridge.getStatus(thread.sessionKey)).toMatchObject({
        connected: true,
        canInput: true,
      });

      await receive(
        encodeLocalSessionFrame({
          type: "session",
          threadId: thread.threadId,
          state: "closed",
          canInput: false,
        }),
      );
      expect(bridge.getStatus(thread.sessionKey) ?? bridge.describeOffline(entry)).toMatchObject({
        connected: true,
        canInput: false,
        reason: "session is not currently available on the device",
      });

      closed.resolve();
      await vi.waitFor(() => {
        expect(bridge.describeOffline(entry)).toMatchObject({
          connected: true,
          reason: "local session source is not connected",
        });
      });
      bridge.onNodeDisconnected("device-1");
      expect(bridge.describeOffline(entry)).toMatchObject({
        connected: false,
        reason: "device is offline",
      });
    } finally {
      lifetime.abort();
    }
  });
});
