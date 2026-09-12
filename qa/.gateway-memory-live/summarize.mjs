import fs from "node:fs";
const result = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const run = result.runs[0];
const phases = Object.fromEntries(
  Object.entries(run.allocationPhases).map(([phase, value]) => [
    phase,
    {
      estimatedAllocatedBytes: value.estimatedAllocatedBytes,
      retainedHeapGrowthBytes: value.retainedHeapGrowthBytes,
      beforeGc: value.beforeGc.memory,
      afterGc: value.afterGc.memory,
      topAllocationStacks: value.topAllocationStacks.slice(0, 10),
    },
  ]),
);
console.log(
  JSON.stringify(
    {
      mode: result.mode,
      sessionCount: result.sessionCount,
      concurrency: result.concurrency,
      summary: result.summary,
      allocationPhases: phases,
      livePassed: run.liveProof?.passed,
      liveCompletions: run.liveProof?.observedCompletions,
      transportCounts: run.liveProof?.transportCounts,
      gatewayExit: run.gatewayExit,
    },
    null,
    2,
  ),
);
