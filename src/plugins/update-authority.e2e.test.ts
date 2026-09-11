import crypto from "node:crypto";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { isPluginNpmProjectDir, resolvePluginNpmProjectDir } from "./install-paths.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import { installPluginFromNpmSpec } from "./install.js";
import { packPlugins, startStaticRegistry } from "./test-helpers/npm-registry-fixtures.js";
import { convergePluginReleaseCohort } from "./update-cohort.js";

const servers: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

describe("plugin update publication authority", () => {
  it.each(["bridge", "installed"] as const)(
    "keeps the old %s package when updater authority closes after consent",
    { timeout: 180_000 },
    async (route) => {
      await withOpenClawTestState(
        { label: `cohort-publication-${route}`, env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
        async (state) => {
          const packageName = `cohort-owner-${crypto.randomUUID()}`;
          const versions = await packPlugins(state.path("packages"), [
            { packageName, version: "1.0.0", manifest: { providers: ["existing-provider"] } },
            {
              packageName,
              version: "2.0.0",
              manifest: { providers: ["existing-provider", "new-provider"] },
            },
          ]);
          const registry = await startStaticRegistry(
            [{ packageName, latest: "2.0.0", versions }],
            servers,
          );
          vi.stubEnv("NPM_CONFIG_REGISTRY", registry);
          vi.stubEnv("npm_config_registry", registry);
          const npmRoot = state.statePath("npm");
          const roots = {
            npmDir: npmRoot,
            extensionsDir: state.statePath("extensions"),
            gitDir: state.statePath("git"),
            stateDir: state.stateDir,
          };
          const installed = await installPluginFromNpmSpec({
            npmDir: npmRoot,
            spec: `${packageName}@1.0.0`,
            logger: { info: () => {}, warn: () => {} },
            timeoutMs: 120_000,
          });
          if (!installed.ok) {
            throw new Error(installed.error);
          }
          const projectRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
          const projectsDir = path.dirname(projectRoot);
          const readPublishedProjects = async () =>
            (await fs.readdir(projectsDir))
              .filter((name) =>
                isPluginNpmProjectDir({
                  packageName,
                  projectDir: path.join(projectsDir, name),
                  npmDir: npmRoot,
                }),
              )
              .toSorted();
          const protectedFiles = [
            path.join(projectRoot, "package.json"),
            path.join(projectRoot, "package-lock.json"),
            path.join(installed.targetDir, "package.json"),
            path.join(installed.targetDir, "dist", "index.js"),
          ];
          const original = await Promise.all(protectedFiles.map((file) => fs.readFile(file)));
          const originalIdentity = await fs.stat(projectRoot);
          const bundledPath = state.path("old", "extensions", packageName);
          const config: OpenClawConfig = {
            plugins: {
              entries: { [packageName]: { enabled: true } },
              ...(route === "bridge" ? { load: { paths: [bundledPath] } } : {}),
              installs: {
                [packageName]:
                  route === "bridge"
                    ? { source: "path", sourcePath: bundledPath, installPath: bundledPath }
                    : {
                        source: "npm",
                        spec: packageName,
                        installPath: installed.targetDir,
                        version: "1.0.0",
                      },
              },
            },
          };
          const control = state.path("control");
          await fs.mkdir(control);
          vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);

          for (const revoke of [true, false]) {
            const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
            await withUpdateCommandExecutor(run.runId, async (executor) => {
              const fence = await executor.enter(state.root, { preflight: true });
              let consented = false;
              let publicationProbeReached = false;
              let publishedProjectsAtRevocation: string[] | undefined;
              const realpath = fs.realpath;
              const probe = vi
                .spyOn(fs, "realpath")
                .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
                  const result = await realpath(...args);
                  if (
                    consented &&
                    !publicationProbeReached &&
                    String(args[0]) === path.dirname(projectRoot)
                  ) {
                    publicationProbeReached = true;
                    fence.assertCurrent();
                    if (revoke) {
                      // Close authority after consent at the publication owner's
                      // filesystem await. Exclude existing private staging from
                      // the canonical project snapshot across that boundary.
                      publishedProjectsAtRevocation = await readPublishedProjects();
                      fence.assertCurrent();
                      releaseUpdateCommandPreflightForHandoff(fence);
                      expect(fence.assertCurrent).toThrow();
                    }
                  }
                  return result;
                });
              try {
                const operation = withPluginInstallRoots(roots, () =>
                  convergePluginReleaseCohort({
                    config,
                    channel: "stable",
                    timeoutMs: 120_000,
                    env: state.env,
                    workspaceDir: state.root,
                    beforePersistentEffect: fence.assertCurrent,
                    ...(route === "bridge"
                      ? {
                          externalizedBundledPluginBridges: [
                            { bundledPluginId: packageName, npmSpec: packageName },
                          ],
                        }
                      : {}),
                    onCapabilityConsent: async (review) => {
                      consented = true;
                      return { reviewToken: review.reviewToken };
                    },
                  }),
                );
                if (revoke) {
                  await expect(operation).rejects.toThrow("ownership is no longer current");
                  expect(publishedProjectsAtRevocation).toBeDefined();
                  expect(await readPublishedProjects()).toEqual(publishedProjectsAtRevocation);
                  expect(
                    await Promise.all(protectedFiles.map((file) => fs.readFile(file))),
                  ).toEqual(original);
                  const currentIdentity = await fs.stat(projectRoot);
                  expect([currentIdentity.dev, currentIdentity.ino]).toEqual([
                    originalIdentity.dev,
                    originalIdentity.ino,
                  ]);
                } else {
                  const result = await operation;
                  const record = result.config.plugins?.installs?.[packageName];
                  expect(record?.version).toBe("2.0.0");
                  expect(result.remainingMissingPayloads).toEqual([]);
                  if (!record?.installPath) {
                    throw new Error("updated install record has no active path");
                  }
                  expect(
                    JSON.parse(
                      await fs.readFile(path.join(record.installPath, "package.json"), "utf8"),
                    ),
                  ).toMatchObject({ version: "2.0.0" });
                }
                expect(consented).toBe(true);
                expect(publicationProbeReached).toBe(true);
              } finally {
                probe.mockRestore();
              }
            });
          }
        },
      );
    },
  );
});
