import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { listLocalSessionEnrollments } from "../../state/local-session-enrollments.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { sessionsLocalHandlers } from "./sessions-local.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

vi.mock("../local-sessions/bridge.js", () => ({
  listRegisteredLocalSessionSources: () => [
    {
      pluginId: "codex",
      sourceId: "codex",
      label: "Codex",
      command: "codex.localSessions.source.v1",
    },
  ],
  getLocalSessionBridge: () => undefined,
}));

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

function enroll(profile: { profileId: string; displayName: string }, scopes: string[]) {
  const respond = vi.fn();
  const options = {
    params: { deviceId: "device-1", sourceId: "codex", agentId: "main" },
    respond,
    client: { authenticatedUserProfile: profile, connect: { scopes } },
    context: {
      nodeRegistry: { get: () => ({ commands: ["codex.localSessions.source.v1"] }) },
      broadcast: vi.fn(),
    },
    // SAFETY: the handler reads only the fields stubbed above; the rest of the request surface is unused here.
  } as unknown as GatewayRequestHandlerOptions;
  return sessionsLocalHandlers["sessions.local.enroll"]!(options).then(() => respond.mock.calls[0]);
}

describe("sessions.local.enroll", () => {
  it("lets only the owner or an admin replace a live share on the same device and source", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "sessions-local-"));
    // A running Gateway always has its state database; the first enroll reads before it writes.
    openOpenClawStateDatabase();
    const [ok] = await enroll({ profileId: "alice", displayName: "Alice" }, ["operator.write"]);
    expect(ok).toBe(true);

    const [refused, , error] = await enroll({ profileId: "bob", displayName: "Bob" }, [
      "operator.write",
    ]);
    expect(refused).toBe(false);
    expect(error).toMatchObject({ message: expect.stringContaining("already shared by Alice") });
    expect(listLocalSessionEnrollments({ deviceId: "device-1" }).map((row) => row.state)).toEqual([
      "pending",
    ]);

    const [adminOk] = await enroll({ profileId: "bob", displayName: "Bob" }, [
      "operator.write",
      "operator.admin",
    ]);
    expect(adminOk).toBe(true);
    expect(
      listLocalSessionEnrollments({ deviceId: "device-1" }).map((row) => [
        row.ownerProfileId,
        row.state,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["alice", "revoked"],
        ["bob", "pending"],
      ]),
    );
  });
});
