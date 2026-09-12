import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_SHA = "8cbd800e3db592297c8c3d41ee0ea71d6ffd31eb";
const PACKAGE_SOURCE_SHA = "20090983b5683ff352ed31e50a15143468913084";
const PRODUCER_TOOLING_SHA = "ec1b82bc0c2c1093c72726ce9de9d8f92c56701f";
const PACKAGE_SHA256 = "0b25b612693be3b4629231ff4445342f859bc0399f207d98b5d884c19caa6e6c";
const PACKAGE_ZIP_SHA256 = "fefa42e7a5d1ad1000a48b0490c44b2d31fe2b3d516fc5c2f4538f5189e10fdb";
const DESCRIPTOR_ZIP_SHA256 = "3516a918bee72ab48a0acbcd9abb20a32b1a706af36966f61568c563c1dee635";
const AI_SHA256 = "e69211c2965f478bc1f195c8e2adbcbe1e958b9714c10bf57f2490a9772d56a9";
const FILE_HASHES = {
  "scripts/release-check.ts": "3a3ad4a1c2bdb18d25225f9d55d12379e890c8cd499220ea5638c0d92006de97",
  "scripts/fixtures/packed-plugin-sdk-setup-consumer.ts":
    "c91b6daa1dfeb7a09314829c925b27419626b6012eaea2da9433e9f3a2a69ffd",
  "scripts/fixtures/packed-plugin-sdk-type-smoke.ts":
    "bdcd222d44d39870b2eee8b046839d64895ce64caf2848626a8d24dc21022e2b",
};
const [stage, cell] = process.argv.slice(2);
if (
  !["download", "prepare", "install", "compile", "collect"].includes(stage) ||
  !["released", "candidate"].includes(cell)
) {
  throw new Error("Expected a fixed proof stage and released or candidate cell");
}
const root = process.cwd();
const evidence = path.join(process.env.RUNNER_TEMP, "signal-sdk-proof", cell);
const consumer = path.join(process.env.RUNNER_TEMP, "signal-sdk-consumer-" + cell);
const bundle = path.join(process.env.RUNNER_TEMP, "signal-sdk-package");
fs.mkdirSync(evidence, { recursive: true });
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const write = (file, value) =>
  fs.writeFileSync(path.join(evidence, file), JSON.stringify(value, null, 2) + "\n");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

function verifySource() {
  assert(git("rev-parse", "HEAD") === SOURCE_SHA, "Source checkout identity differs");
  execFileSync("git", ["diff", "--exit-code", "HEAD", "--"], { cwd: root, stdio: "inherit" });
  for (const [file, expected] of Object.entries(FILE_HASHES)) {
    assert(digest(path.join(root, file)) === expected, "Source bytes differ: " + file);
  }
}

async function releaseOwner() {
  verifySource();
  return await import(pathToFileURL(path.join(root, "scripts/release-check.ts")).href);
}

async function runRecorded(name, invocation, owner) {
  const receipt = {
    stage: name,
    cell,
    command: invocation.command,
    args: invocation.args,
    cwd: consumer,
    started: new Date().toISOString(),
    exitCode: null,
    signal: null,
  };
  write(name + ".json", receipt);
  try {
    owner.runReleaseCheckCommand(invocation, { cwd: consumer, stdio: "inherit" });
    receipt.exitCode = 0;
  } catch (error) {
    receipt.exitCode = typeof error.status === "number" ? error.status : null;
    receipt.signal = error.signal ?? null;
    receipt.error = error.message;
    throw error;
  } finally {
    receipt.finished = new Date().toISOString();
    write(name + ".json", receipt);
  }
}

async function download() {
  assert(cell === "candidate", "Only candidate downloads a prepared bundle");
  verifySource();
  const archive = execFileSync("gh", [
    "api",
    "repos/openclaw/openclaw/actions/artifacts/10295535936/zip",
  ]);
  const descriptorZip = path.join(evidence, "descriptor.zip");
  fs.writeFileSync(descriptorZip, archive);
  assert(digest(descriptorZip) === DESCRIPTOR_ZIP_SHA256, "Descriptor archive digest differs");
  const descriptorBytes = execFileSync("unzip", ["-p", descriptorZip, "prepared-npm-bundle.json"]);
  const descriptorFile = path.join(evidence, "prepared-npm-bundle.json");
  fs.writeFileSync(descriptorFile, descriptorBytes);
  const descriptor = json(descriptorFile);
  assert(
    descriptor.artifact.id === "10295825348" && descriptor.artifact.digest === PACKAGE_ZIP_SHA256,
    "Package artifact identity differs",
  );
  assert(
    descriptor.artifact.runId === "34684811000" && descriptor.artifact.runAttempt === "1",
    "Producer attempt differs",
  );
  assert(descriptor.package.sha256 === PACKAGE_SHA256, "Package digest differs");
  const owner = await import(
    pathToFileURL(path.join(root, "scripts/npm-prepared-bundle.mjs")).href
  );
  await owner.downloadPreparedNpmBundle({
    descriptor,
    repository: "openclaw/openclaw",
    sourceSha: PACKAGE_SOURCE_SHA,
    toolingSha: PRODUCER_TOOLING_SHA,
    outputDir: bundle,
    token: process.env.GH_TOKEN,
    npmDistTag: "beta",
    releaseTag: "v2026.9.4",
  });
  assert(
    digest(path.join(bundle, "openclaw-2026.9.4.tgz")) === PACKAGE_SHA256,
    "Downloaded package bytes differ",
  );
  assert(
    digest(path.join(bundle, "openclaw-ai-2026.9.4.tgz")) === AI_SHA256,
    "Downloaded AI companion bytes differ",
  );
  fs.copyFileSync(
    path.join(bundle, "package-bundle.json"),
    path.join(evidence, "package-bundle.json"),
  );
  write("artifact-identity.json", {
    descriptorArtifactId: "10295535936",
    descriptorZipSha256: DESCRIPTOR_ZIP_SHA256,
    packageArtifactId: "10295825348",
    packageZipSha256: PACKAGE_ZIP_SHA256,
    packageSha256: PACKAGE_SHA256,
    aiSha256: AI_SHA256,
    packageSourceSha: PACKAGE_SOURCE_SHA,
    producerToolingSha: PRODUCER_TOOLING_SHA,
  });
}

async function prepare() {
  assert(
    !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN,
    "Consumer steps must not receive an API token",
  );
  const owner = await releaseOwner();
  assert(!fs.existsSync(consumer), "Consumer directory already exists");
  const packageSpec =
    cell === "released" ? "2026.9.4" : "file:" + path.join(bundle, "openclaw-2026.9.4.tgz");
  const aiPackageSpec =
    cell === "candidate" ? "file:" + path.join(bundle, "openclaw-ai-2026.9.4.tgz") : undefined;
  owner.createPackedPluginSdkTypescriptSmokeProject({
    consumerDir: consumer,
    packageSpec,
    aiPackageSpec,
  });
  const fixture = path.join(root, "scripts/fixtures/packed-plugin-sdk-setup-consumer.ts");
  if (cell === "released") fs.copyFileSync(fixture, path.join(consumer, "src/index.ts"));
  assert(
    digest(path.join(consumer, "src/packed-plugin-sdk-setup-consumer.ts")) ===
      FILE_HASHES["scripts/fixtures/packed-plugin-sdk-setup-consumer.ts"],
    "Copied fixture bytes differ",
  );
  const indexHash =
    cell === "released"
      ? FILE_HASHES["scripts/fixtures/packed-plugin-sdk-setup-consumer.ts"]
      : FILE_HASHES["scripts/fixtures/packed-plugin-sdk-type-smoke.ts"];
  assert(digest(path.join(consumer, "src/index.ts")) === indexHash, "Consumer entry bytes differ");
  write("input-identity.json", {
    purpose: "Independent declaration proof; not release qualification",
    cell,
    sourceSha: SOURCE_SHA,
    proofWorkflowSha: process.env.PROOF_WORKFLOW_SHA,
    proofWorkflowRef: process.env.GITHUB_WORKFLOW_REF,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    node: process.version,
    packageSpec,
    aiPackageSpec,
    fixtureAndOwnerSha256: FILE_HASHES,
    candidateSourceSha: cell === "candidate" ? PACKAGE_SOURCE_SHA : null,
  });
}

async function install() {
  assert(
    !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN,
    "Consumer steps must not receive an API token",
  );
  const owner = await releaseOwner();
  await runRecorded(
    "install",
    owner.resolveReleaseNpmCommand(["install", "--ignore-scripts", "--no-audit", "--no-fund"]),
    owner,
  );
}

async function compile() {
  assert(
    !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN,
    "Consumer steps must not receive an API token",
  );
  const owner = await releaseOwner();
  const packageRoot = path.join(consumer, "node_modules/openclaw");
  const pkg = json(path.join(packageRoot, "package.json"));
  const build = json(path.join(packageRoot, "dist/build-info.json"));
  assert(pkg.version === "2026.9.4", "Installed package version differs");
  if (cell === "candidate")
    assert(build.commit === PACKAGE_SOURCE_SHA, "Installed candidate commit differs");
  write("installed-identity.json", {
    packageVersion: pkg.version,
    buildInfo: build,
    setupExport: pkg.exports["./plugin-sdk/setup"],
    setupRuntimeExport: pkg.exports["./plugin-sdk/setup-runtime"],
    packageLockSha256: digest(path.join(consumer, "package-lock.json")),
  });
  const tsc = [
    path.join(consumer, "node_modules/typescript/bin/tsc"),
    path.join(packageRoot, "node_modules/typescript/bin/tsc"),
  ].find((file) => fs.existsSync(file));
  assert(tsc, "Installed TypeScript compiler missing");
  console.log("Signal SDK consumer proof: compiling " + cell);
  await runRecorded(
    "compile",
    { command: process.execPath, args: [tsc, "-p", "tsconfig.json", "--pretty", "false"] },
    owner,
  );
  console.log("Signal SDK consumer proof: " + cell + " compiled successfully");
}

function collect() {
  for (const file of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "src/index.ts",
    "src/packed-plugin-sdk-setup-consumer.ts",
  ]) {
    const source = path.join(consumer, file);
    if (!fs.existsSync(source)) continue;
    const target = path.join(evidence, "consumer", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  const compileReceipt = path.join(evidence, "compile.json");
  write(
    "result.json",
    fs.existsSync(compileReceipt)
      ? { cell, compiler: json(compileReceipt), releaseQualification: false }
      : { cell, compiler: { status: "not-run" }, releaseQualification: false },
  );
}

try {
  if (stage === "download") await download();
  else if (stage === "prepare") await prepare();
  else if (stage === "install") await install();
  else if (stage === "compile") await compile();
  else collect();
} catch (error) {
  write(stage + "-failure.json", {
    stage,
    cell,
    message: error.message,
    stack: error.stack,
    time: new Date().toISOString(),
  });
  console.error(error);
  process.exitCode = typeof error.status === "number" && error.status !== 0 ? error.status : 1;
}
