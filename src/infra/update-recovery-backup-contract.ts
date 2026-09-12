import { z } from "zod";

export const updateRecoveryBackupRefSchema = z
  .object({
    directory: z.string().min(1),
    manifestPath: z.string().min(1),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type UpdateRecoveryBackupRef = z.infer<typeof updateRecoveryBackupRefSchema>;

export type UpdateRecoveryRestoreWarning = {
  kind: "discarded-post-capture-writes" | "candidate-retirement-failed";
  sourcePath: string;
  resourceKind: "sqlite" | "file" | "directory" | "symlink";
  message?: string;
};

export type UpdateRecoveryRestoreResult = {
  warnings: UpdateRecoveryRestoreWarning[];
};

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
export const updateRecoveryWarningSchema = z
  .object({
    kind: z.literal("undeclared-migration-resources"),
    pluginId: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export const updateRecoveryTerminalOutcomeSchema = z
  .object({
    status: z.enum(["restored", "committed"]),
    error: z.string().max(4096).optional(),
    manifestSha256: sha256,
  })
  .strict();

const updateRecoveryRetirementSchema = z
  .object({
    directory: z.string().min(1).max(4096),
    installRoot: z.string().min(1).max(4096),
    stateDir: z.string().min(1).max(4096),
    configPath: z.string().min(1).max(4096),
    identity: z.object({ dev: z.number(), ino: z.number(), birthtimeMs: z.number() }).strict(),
    outcome: z.enum(["committed", "restored"]),
  })
  .strict();
export type UpdateRecoveryRetirement = z.infer<typeof updateRecoveryRetirementSchema>;

export const updateRecoveryCaptureStateSchema = z
  .object({
    manifestSha256: sha256,
    status: z.enum(["pending", "restore-failed"]),
    warnings: z.array(updateRecoveryWarningSchema),
    error: z.string().max(4096).optional(),
    doctorCompleted: z.boolean().optional(),
    restored: z.literal(true).optional(),
    retirement: updateRecoveryRetirementSchema.optional(),
  })
  .strict();
export type UpdateRecoveryCaptureState = z.infer<typeof updateRecoveryCaptureStateSchema>;

export function mergeUpdateRecoveryCaptureState(
  previous: UpdateRecoveryCaptureState | undefined,
  patch: Pick<UpdateRecoveryCaptureState, "manifestSha256"> & Partial<UpdateRecoveryCaptureState>,
): UpdateRecoveryCaptureState {
  if (previous && previous.manifestSha256 !== patch.manifestSha256) {
    throw new Error("Update recovery receipts belong to another capture.");
  }
  return updateRecoveryCaptureStateSchema.parse({
    status: "pending",
    warnings: [],
    ...previous,
    ...patch,
    ...(previous?.restored ? { restored: true } : {}),
  });
}
