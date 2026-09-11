// A profile-minted connect link carries a sharing intent; when the laptop that
// redeemed it finishes pairing, the intent becomes that profile's enrollments so
// the person never has to visit the Devices page or answer a separate offer.
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  activateLocalSessionConnectIntent,
  createLocalSessionEnrollment,
} from "../../state/local-session-enrollments.js";
import type { GatewayBroadcastFn } from "../server-broadcast-types.js";
import { getLocalSessionBridge, listRegisteredLocalSessionSources } from "./bridge.js";

const log = createSubsystemLogger("gateway/local-sessions");

export function activateLocalSessionConnectIntentForDevice(params: {
  setupId: string | undefined;
  deviceId: string;
  broadcast: GatewayBroadcastFn;
}): void {
  if (!params.setupId) {
    return;
  }
  const intent = activateLocalSessionConnectIntent({
    setupId: params.setupId,
    deviceId: params.deviceId,
  });
  if (!intent) {
    return;
  }
  const sources = listRegisteredLocalSessionSources();
  for (const sourceId of intent.sourceIds) {
    const source = sources.find((candidate) => candidate.sourceId === sourceId);
    if (!source) {
      log.warn(
        `connect intent ${intent.setupId} names unknown local session source ${sourceId}; skipped`,
      );
      continue;
    }
    const enrollment = createLocalSessionEnrollment({
      ownerProfileId: intent.ownerProfileId,
      ownerLabel: intent.ownerLabel,
      deviceId: params.deviceId,
      pluginId: source.pluginId,
      sourceId,
      agentId: intent.agentId,
      setupId: intent.setupId,
    });
    params.broadcast("sessions.local.enrollment", { enrollment });
    getLocalSessionBridge()?.onEnrollmentChanged(enrollment);
  }
}
