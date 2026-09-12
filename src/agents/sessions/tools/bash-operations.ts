import { existsSync } from "node:fs";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { toErrorObject } from "../../../infra/errors.js";
import { releaseChildProcessOutputAfterExit } from "../../../process/child-process.js";
import { COMMAND_PROCESS_TREE_KILL_GRACE_MS } from "../../../process/exec-spawn.js";
import { createCommandTerminationController } from "../../../process/exec-termination.js";
import { spawnCommand } from "../../../process/exec.js";
import {
  buildShellCommandInvocation,
  getBashShellConfig,
  getBashShellEnv,
} from "../../shell-utils.js";

/**
 * Minimal shell execution interface injected into bash session tools.
 */

export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      /**
       * stdout and stderr are independent pipes, so each needs its own decode
       * state; tag chunks to keep them apart. Untagged chunks share one lane,
       * preserving behavior for operations that cannot distinguish streams.
       */
      onData: (data: Buffer, stream?: "stdout" | "stderr") => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

export function resolveBashTimeoutMs(timeoutSeconds: unknown): number | undefined {
  if (timeoutSeconds === undefined) {
    return undefined;
  }
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    throw new Error("Invalid timeout: must be a positive finite number of seconds");
  }
  return resolveTimerTimeoutMs(timeoutSeconds * 1000, 1);
}

/**
 * Create bash operations using OpenClaw runtime's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want OpenClaw runtime's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout, env }) => {
      return new Promise((resolve, reject) => {
        const shellConfig = getBashShellConfig(options?.shellPath);
        const invocation = buildShellCommandInvocation(command, shellConfig);
        if (!existsSync(cwd)) {
          reject(
            new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`),
          );
          return;
        }
        const cancelController = new AbortController();
        const shellEnv = env ?? getBashShellEnv(shellConfig.shell);
        const child = spawnCommand(invocation.argv, {
          baseEnv: {},
          buffer: false,
          cancelSignal: cancelController.signal,
          cwd,
          detached: process.platform !== "win32",
          env: shellEnv,
          forceKillAfterDelay: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
          ...(invocation.input === undefined ? {} : { input: invocation.input }),
          reject: false,
          stdio: [invocation.stdin, "pipe", "pipe"],
        });
        const releaseOutput = releaseChildProcessOutputAfterExit(child.nodeChildProcess);
        let childExited = false;
        child.nodeChildProcess.once("exit", () => {
          childExited = true;
        });
        let commandSettled = false;
        const terminationController = createCommandTerminationController({
          child: child.nodeChildProcess,
          cancelController,
          baseEnv: {},
          env: shellEnv,
          processTree: { mode: "force" },
          killGraceMs: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
          isChildExited: () => childExited,
          isCommandSettled: () => commandSettled,
        });
        let terminationStarted = false;
        const terminate = () => {
          if (terminationStarted) {
            return;
          }
          terminationStarted = true;
          if (!terminationController.terminate()) {
            cancelController.abort();
          }
        };
        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutMs = resolveBashTimeoutMs(timeout);
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            terminate();
          }, timeoutMs);
        }
        // Stream stdout and stderr. Tag each pipe so downstream decode state
        // stays per-stream; a pending sequence on one must not eat the other.
        child.stdout?.on("data", (data: Buffer) => onData(data, "stdout"));
        child.stderr?.on("data", (data: Buffer) => onData(data, "stderr"));
        // Handle abort signal by killing the entire process tree.
        const onAbort = terminate;
        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }
        void child
          .then(async (result) => {
            commandSettled = true;
            await terminationController.settle();
            if (result.failed && result.exitCode === undefined && result.signal === undefined) {
              if (result instanceof Error) {
                throw result;
              }
              throw new Error(`Failed to launch shell: ${shellConfig.shell}`, { cause: result });
            }
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
            if (signal) {
              signal.removeEventListener("abort", onAbort);
            }
            if (signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            if (timedOut) {
              reject(new Error(`timeout:${timeout}`));
              return;
            }
            resolve({ exitCode: result.exitCode ?? (result.failed ? 1 : 0) });
          })
          .catch(async (err: unknown) => {
            commandSettled = true;
            await terminationController.settle();
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
            if (signal) {
              signal.removeEventListener("abort", onAbort);
            }
            reject(toErrorObject(err, "Non-Error rejection"));
          })
          .finally(releaseOutput);
      });
    },
  };
}
