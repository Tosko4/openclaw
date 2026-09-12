import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";

const matcher = {
  source: "credential-value",
  *exec(input: string) {
    const match = "credential-value";
    const offset = input.indexOf(match);
    if (offset >= 0) {
      yield { match, groups: [], input, offset };
    }
  },
};

const patterns: readonly (typeof matcher | string | RegExp)[] = [
  matcher,
  "other=(\\w+)",
  /more=(\w+)/g,
];
const text = "prefix credential-value suffix";
const result: string = redactSensitiveText(text, { mode: "tools", patterns });
const sensitiveFieldResult: string = redactSensitiveText(text, {
  sensitiveFieldPatterns: [matcher],
});
if (result === text) {
  throw new Error("security-runtime#redactSensitiveText did not apply the executable matcher");
}
console.log(
  JSON.stringify({
    entryPoint: "openclaw/plugin-sdk/security-runtime#redactSensitiveText",
    result,
    sensitiveFieldResult,
  }),
);
