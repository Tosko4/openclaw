import type { note } from "../../../../packages/terminal-core/src/note.js";
import { createConfigIO } from "../../../config/io.js";
import type { PluginCapabilityConsentHandler } from "../../../plugins/capability-consent.js";
import { withPluginLifecycleLease } from "../../../plugins/plugin-lifecycle-lease.js";
import {
  formatStartupPluginVerificationFailure,
  runStartupUpgradeConvergence,
} from "../../doctor-config-preflight-plugin-verification.js";
import { importShippedPluginInstallConfigForDoctor } from "./plugin-registry-migration.js";

/** Repair the migration contract generation without retiring its config inputs. */
export async function convergeDoctorMigrationPlugins(params: {
  env: NodeJS.ProcessEnv;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  onNote?: typeof note;
}): Promise<void> {
  await withPluginLifecycleLease({}, async () => {
    const snapshot = await createConfigIO({
      env: params.env,
      observe: false,
      pluginValidation: "core-only",
    }).readConfigFileSnapshot();
    // Old configs keep the only package locator in plugins.installs. Import
    // records only; the later migration still needs the original source config.
    await importShippedPluginInstallConfigForDoctor(snapshot);
    const convergence = await runStartupUpgradeConvergence({
      cfg: snapshot.sourceConfig,
      env: params.env,
      onCapabilityConsent: params.onCapabilityConsent,
      onNote: params.onNote,
    });
    if (convergence.blockingDiagnostic) {
      throw new Error(formatStartupPluginVerificationFailure(convergence.blockingDiagnostic));
    }
    if (convergence.quarantinedPlugins.length > 0) {
      throw new Error(
        "Updated plugin payloads are unavailable; run `openclaw update repair` before migrating state.",
      );
    }
  });
}
