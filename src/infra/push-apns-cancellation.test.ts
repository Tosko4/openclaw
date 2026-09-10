import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import http2 from "node:http2";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { APNS_HTTP2_CANCEL_CODE } from "./push-apns-http2.js";
import { sendApnsBackgroundWake, sendApnsLiveActivity } from "./push-apns.js";
import { createApnsLiveActivityPayload } from "./push-live-activity-payload.js";

const testAuthPrivateKey = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
}).privateKey.export({ format: "pem", type: "pkcs8" });

function createDirectTransport() {
  const requestEnded = createDeferred();
  const request = Object.assign(new EventEmitter(), {
    destroyed: false,
    setTimeout: vi.fn(),
    close: vi.fn(),
    end: vi.fn(() => requestEnded.resolve()),
  });
  request.close.mockImplementation(() => {
    request.destroyed = true;
    request.emit("close");
  });
  const session = Object.assign(new EventEmitter(), {
    close: vi.fn(),
    destroy: vi.fn(),
    request: vi.fn<(headers: http2.OutgoingHttpHeaders) => typeof request>(() => request),
  });
  session.close.mockImplementation(() => session.emit("close"));
  session.destroy.mockImplementation(() => session.emit("close"));
  const connect = vi
    .spyOn(http2, "connect")
    .mockReturnValue(session as unknown as http2.ClientHttp2Session);
  return {
    requestEnded,
    request,
    session,
    connect,
    params: {
      registration: {
        nodeId: "ios-node-cancelled-stream",
        transport: "direct" as const,
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
        environment: "production" as const,
        updatedAtMs: 1,
      },
      nodeId: "ios-node-cancelled-stream",
      wakeReason: "node.invoke",
      auth: {
        teamId: "TEAM123",
        keyId: "KEY123",
        privateKey: testAuthPrivateKey,
      },
    },
  };
}

describe("APNs cancellation", () => {
  it.each(["ordinary", "activity"] as const)(
    "cancels the active %s stream when the owner aborts",
    async (kind) => {
      const { requestEnded, request, session, connect, params } = createDirectTransport();
      const controller = new AbortController();
      const reason = kind === "activity" ? "attempt deadline reached" : "pairing removed";
      const sending =
        kind === "activity"
          ? sendApnsLiveActivity({
              registration: {
                purpose: "liveActivity",
                transport: "direct",
                bundleId: params.registration.topic,
                token: params.registration.token,
                environment: params.registration.environment,
              },
              auth: params.auth,
              payload: createApnsLiveActivityPayload({
                snapshot: {
                  status: "running",
                  observedAtMs: 1_000,
                },
                timestamp: 1,
              }),
              signal: controller.signal,
              assertCurrent: () => undefined,
            })
          : sendApnsBackgroundWake({
              ...params,
              signal: controller.signal,
              isCurrent: vi.fn().mockResolvedValue(true),
            });
      try {
        await withTestTimeout(requestEnded.promise, 1_000, "APNs request.end was not called");
        expect(request.end).toHaveBeenCalledTimes(1);
        controller.abort(new Error(reason));

        await expect(sending).rejects.toThrow(reason);
        expect(request.close).toHaveBeenCalledWith(APNS_HTTP2_CANCEL_CODE);
        expect(session.close).toHaveBeenCalledTimes(1);
        expect(session.destroy).not.toHaveBeenCalled();
      } finally {
        controller.abort(new Error("test cleanup"));
        await sending.catch(() => undefined);
        connect.mockRestore();
      }
    },
  );

  it.each(["current", "revoked", "aborted", "connection failed"] as const)(
    "admits direct HTTP/2 exactly once after async preparation: %s",
    async (outcome) => {
      const { requestEnded, request, session, connect, params } = createDirectTransport();
      const checking = createDeferred();
      const currentness = createDeferred<boolean>();
      const controller = new AbortController();
      const events: string[] = [];
      let current = true;
      const assertCurrent = vi.fn(() => {
        if (!current) {
          throw new Error("revoked");
        }
        events.push("admit");
        return undefined;
      });
      session.request.mockImplementation(() => {
        events.push("request");
        return request;
      });
      const sending = sendApnsBackgroundWake({
        ...params,
        signal: controller.signal,
        assertCurrent,
        isCurrent: vi
          .fn<() => Promise<boolean>>()
          .mockResolvedValueOnce(true)
          .mockImplementationOnce(() => {
            checking.resolve();
            return currentness.promise;
          }),
      });
      try {
        await withTestTimeout(checking.promise, 1_000, "APNs currentness check did not start");
        expect(assertCurrent).not.toHaveBeenCalled();
        expect(session.request).not.toHaveBeenCalled();

        if (outcome === "current") {
          currentness.resolve(true);
          await withTestTimeout(requestEnded.promise, 1_000, "APNs request.end was not called");
          expect(events).toEqual(["admit", "request"]);
          expect(assertCurrent).toHaveBeenCalledTimes(1);
          request.emit("response", { ":status": 200 });
          request.emit("end");
          await expect(sending).resolves.toMatchObject({ ok: true, status: 200 });
        } else {
          const rejected = expect(sending).rejects.toThrow(outcome);
          if (outcome === "revoked") {
            current = false;
          } else if (outcome === "aborted") {
            controller.abort(new Error(outcome));
          } else {
            session.emit("error", new Error(outcome));
          }
          currentness.resolve(true);
          await rejected;
          expect(session.request).not.toHaveBeenCalled();
          expect(request.end).not.toHaveBeenCalled();
          expect(assertCurrent).toHaveBeenCalledTimes(outcome === "revoked" ? 1 : 0);
        }
      } finally {
        controller.abort(new Error("test cleanup"));
        currentness.resolve(false);
        await sending.catch(() => undefined);
        connect.mockRestore();
      }
    },
  );

  it.each(["running", "done"] as const)(
    "sends immutable %s activity bytes with a derived topic and priority",
    async (status) => {
      const { requestEnded, request, session, connect, params } = createDirectTransport();
      const controller = new AbortController();
      const snapshot = {
        sourceIncarnation: "source-owner",
        sequence: 1,
        observedAtMs: 978_307_201_250,
        status,
      };
      const payload = createApnsLiveActivityPayload({ snapshot, timestamp: 978_307_210 });
      const assertCurrent = vi.fn(() => {
        expect(session.request).not.toHaveBeenCalled();
        return undefined;
      });
      const sending = sendApnsLiveActivity({
        registration: {
          purpose: "liveActivity",
          transport: "direct",
          bundleId: "ai.openclaw.ios",
          token: "DEFA1234DEFA1234DEFA1234DEFA1234",
          environment: "sandbox",
        },
        auth: params.auth,
        payload,
        signal: controller.signal,
        assertCurrent,
      });
      snapshot.observedAtMs += 100_000;
      try {
        await withTestTimeout(requestEnded.promise, 1_000, "activity request.end was not called");
        expect(assertCurrent).toHaveBeenCalledTimes(1);
        expect(connect).toHaveBeenCalledWith("https://api.sandbox.push.apple.com");
        expect(session.request.mock.calls[0]?.[0]).toMatchObject({
          ":method": "POST",
          ":path": "/3/device/defa1234defa1234defa1234defa1234",
          "apns-topic": "ai.openclaw.ios.push-type.liveactivity",
          "apns-push-type": "liveactivity",
          "apns-priority": status === "done" ? "10" : "5",
          "apns-expiration": "0",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload.json, "utf8")),
        });
        expect(request.end).toHaveBeenCalledWith(payload.json);
        request.emit("response", { ":status": 200 });
        request.emit("end");
        await expect(sending).resolves.toMatchObject({
          ok: true,
          topic: "ai.openclaw.ios.push-type.liveactivity",
          transport: "direct",
        });
      } finally {
        controller.abort(new Error("test cleanup"));
        await sending.catch(() => undefined);
        connect.mockRestore();
      }
    },
  );

  it.each(["", "ai.openclaw.ios.push-type.liveactivity", "a".repeat(255)])(
    "rejects an invalid base bundle ID without consuming authority",
    async (bundleId) => {
      const { session, connect, params } = createDirectTransport();
      const assertCurrent = vi.fn(() => undefined);
      try {
        await expect(
          sendApnsLiveActivity({
            registration: {
              purpose: "liveActivity",
              transport: "direct",
              token: params.registration.token,
              environment: "sandbox",
              bundleId,
            },
            auth: params.auth,
            payload: createApnsLiveActivityPayload({
              snapshot: {
                status: "running",
                observedAtMs: 1_000,
              },
              timestamp: 1,
            }),
            signal: new AbortController().signal,
            assertCurrent,
          }),
        ).rejects.toThrow("Live Activity base bundle ID required");
        expect(connect).not.toHaveBeenCalled();
        expect(session.request).not.toHaveBeenCalled();
        expect(assertCurrent).not.toHaveBeenCalled();
      } finally {
        connect.mockRestore();
      }
    },
  );
});
