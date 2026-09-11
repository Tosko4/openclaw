// Devices page dialog copy. The page decides when a dialog may run and what
// happens after; these builders only turn an intent into dialog options.
import type { ConfirmDialogOptions } from "../../components/confirm-dialog.ts";
import type { showSecretRevealDialog } from "../../components/secret-reveal-dialog.ts";
import { t } from "../../i18n/index.ts";
import type { InventoryRemovalRequest, rotateDeviceToken } from "../../lib/nodes/index.ts";

export type DevicesConfirmPrompt = Omit<ConfirmDialogOptions, "danger" | "signal">;

export type InventoryRemovalPrompt =
  | { kind: "entry"; entry: InventoryRemovalRequest }
  | { kind: "stale"; entries: InventoryRemovalRequest[] };

type RotationOutcome = NonNullable<Awaited<ReturnType<typeof rotateDeviceToken>>>;
type SecretRevealOptions = Parameters<typeof showSecretRevealDialog>[0];

export function inventoryRemovalPrompt(prompt: InventoryRemovalPrompt): DevicesConfirmPrompt {
  if (prompt.kind === "entry") {
    return {
      title: t("devices.inventory.removePromptTitle", { name: prompt.entry.name }),
      message: t("devices.inventory.removePromptBody"),
      details: t("devices.inventory.deviceId", { id: prompt.entry.id }),
      confirmLabel: t("devices.inventory.remove"),
    };
  }
  const count = prompt.entries.length;
  return {
    title: t(
      count === 1
        ? "devices.inventory.removeStalePromptTitleOne"
        : "devices.inventory.removeStalePromptTitle",
      { count: String(count) },
    ),
    message: t("devices.inventory.removeStalePromptBody"),
    confirmLabel: t("devices.inventory.remove"),
  };
}

export function pairingRejectPrompt(target: "device" | "node"): DevicesConfirmPrompt {
  return {
    title: t(
      target === "device"
        ? "devices.inventory.rejectDevicePromptTitle"
        : "devices.inventory.rejectNodePromptTitle",
    ),
    message: t("devices.inventory.rejectPromptBody"),
    confirmLabel: t("devices.inventory.reject"),
  };
}

export function tokenRevokePrompt(deviceId: string, role: string): DevicesConfirmPrompt {
  return {
    title: t("devices.inventory.revokePromptTitle", { role }),
    message: t("devices.inventory.revokePromptBody"),
    details: t("devices.inventory.deviceId", { id: deviceId }),
    confirmLabel: t("devices.inventory.revoke"),
  };
}

/** The replacement token when the Gateway issued it to this operator, otherwise what it did instead. */
export function rotationOutcomeDialog(
  device: { id: string; name: string },
  role: string,
  outcome: RotationOutcome,
): SecretRevealOptions {
  if (outcome.delivery === "in-band") {
    return {
      title: t("devices.inventory.rotatePromptTitle", { role }),
      message: t("devices.inventory.rotatePromptBody"),
      secret: outcome.token,
      acknowledgeLabel: t("devices.inventory.rotateAcknowledge"),
      dismissHint: t("devices.inventory.rotateDismissHint"),
    };
  }
  // The title carries the announcement and the device, so the body is only the
  // reassurance. Naming the transient disconnect here would raise an alarm the
  // very next line has to walk back.
  return {
    title: t("devices.inventory.rotateWithheldTitle", { device: device.name }),
    status: "success",
    message: t("devices.inventory.rotateWithheldNext"),
    callout: t("devices.inventory.rotateWithheldException"),
    acknowledgeLabel: t("common.close"),
    note: t("devices.inventory.rotateWithheldNote"),
  };
}
