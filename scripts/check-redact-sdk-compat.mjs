import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function checkRedactSdkCompatibility(repoRoot, tsgoPath) {
  const outputRoot = join(repoRoot, "dist", "sdk-compat-proof");
  mkdirSync(outputRoot, { recursive: true });
  const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-redact-sdk-compat-"));
  const sharedSource = readFileSync(join(repoRoot, "scripts/fixtures/redact-sdk-consumer.ts"));
  const matcherSource = readFileSync(
    join(repoRoot, "scripts/fixtures/redact-sdk-matcher-consumer.ts"),
  );
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const report = {
    entryPoint: "openclaw/plugin-sdk/security-runtime#redactSensitiveText",
    productionMerge: "172d068b3435f8774974cf8ece0c1de5fb4d76f1",
    candidateHead: "78869554857369b9dcb3b9e8145dd36d740de03c",
    workflowHead: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    sharedFixtureSha256: digest(sharedSource),
    candidateMatcherFixtureSha256: digest(matcherSource),
    compileScope:
      "strict external consumer; skipLibCheck matches the existing SDK consumer check; declaration dependencies are not independently checked",
    commands: [],
    packages: [],
    completed: false,
  };
  const run = (label, cwd, command, args) => {
    const result = spawnSync(command, args, { cwd, encoding: "utf8" });
    const receipt = {
      label,
      command: [command, ...args],
      exitCode: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.message,
    };
    report.commands.push(receipt);
    console.log(`SDK_COMPAT_COMMAND ${JSON.stringify(receipt)}`);
    return result.status === 0 && !result.error;
  };
  let failed = 0;
  try {
    if (!run("compiler-version", repoRoot, process.execPath, [tsgoPath, "--version"])) failed += 1;
    if (!run("execution-head", repoRoot, "git", ["rev-parse", "HEAD"])) failed += 1;
    for (const pin of ["shipped", "candidate"]) {
      const consumer = join(tempRoot, pin);
      mkdirSync(consumer, { recursive: true });
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({ private: true, type: "module" }),
      );
      if (pin === "shipped") {
        if (
          !run("shipped-install", consumer, "npm", [
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--save-exact",
            "openclaw@2026.9.4",
          ])
        ) {
          failed += 1;
          continue;
        }
        copyFileSync(
          join(consumer, "package-lock.json"),
          join(outputRoot, "shipped-package-lock.json"),
        );
      } else {
        mkdirSync(join(consumer, "node_modules"));
        symlinkSync(
          repoRoot,
          join(consumer, "node_modules", "openclaw"),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const packageRoot = join(consumer, "node_modules", "openclaw");
      const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
      const subpath = manifest.exports["./plugin-sdk/security-runtime"];
      report.packages.push({
        pin,
        version: manifest.version,
        subpath,
        declarationSha256: digest(readFileSync(join(packageRoot, subpath.types))),
      });
      writeFileSync(join(consumer, "index.ts"), sharedSource);
      writeFileSync(
        join(consumer, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            lib: ["DOM", "DOM.Iterable", "ES2023"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            target: "ES2022",
            types: [],
          },
          include: ["index.ts"],
        }),
      );
      if (
        !run(`${pin}-shared-compile`, consumer, process.execPath, [
          tsgoPath,
          "-p",
          "tsconfig.json",
          "--pretty",
          "false",
        ])
      )
        failed += 1;
      if (!run(`${pin}-shared-runtime`, consumer, process.execPath, ["index.ts"])) failed += 1;
      if (pin === "candidate") {
        writeFileSync(join(consumer, "index.ts"), matcherSource);
        if (
          !run("candidate-matcher-compile", consumer, process.execPath, [
            tsgoPath,
            "-p",
            "tsconfig.json",
            "--pretty",
            "false",
          ])
        )
          failed += 1;
        if (!run("candidate-matcher-runtime", consumer, process.execPath, ["index.ts"]))
          failed += 1;
      }
    }
    report.completed = true;
    return failed;
  } finally {
    writeFileSync(join(outputRoot, "shared-consumer.ts"), sharedSource);
    writeFileSync(join(outputRoot, "candidate-matcher-consumer.ts"), matcherSource);
    writeFileSync(
      join(outputRoot, "receipt.json"),
      JSON.stringify({ ...report, failures: failed }, null, 2),
    );
    console.log(`SDK_COMPAT_PROOF ${JSON.stringify({ ...report, failures: failed })}`);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
