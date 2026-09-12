import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";

const customStrings: readonly string[] = ["custom=([^&\\s]+)"];
const customRegexes: readonly RegExp[] = [/custom=([^&\s]+)/g];
const subjects = {
  custom: "custom=opaque-value-123456789&safe=1",
  form: "client_se+cret=opaque-value-123&safe=1",
  digest:
    'Authorization: Digest username="alice", realm="example", response="digest-response-1234567890abcdef"',
  userinfo: `https://user:${"Ab9Q".repeat(10)}@example.test/path`,
  publicPath: `https://example.test/${"Ab9Q".repeat(10)}@latest`,
};

const results = Object.entries(subjects).map(([subject, text]) => {
  const defaultResult: string = redactSensitiveText(text);
  return {
    subject,
    defaultResult,
    emptyOptions: redactSensitiveText(text, {}),
    tools: redactSensitiveText(text, { mode: "tools" }),
    off: redactSensitiveText(text, { mode: "off" }),
    emptyPatterns: redactSensitiveText(text, { patterns: [] }),
    customStrings: redactSensitiveText(text, { patterns: customStrings }),
    customRegexes: redactSensitiveText(text, { patterns: customRegexes }),
    mixedPatterns: redactSensitiveText(text, { patterns: [...customStrings, /additional=(\w+)/g] }),
    explicitTools: redactSensitiveText(text, { mode: "tools", patterns: customStrings }),
    explicitOff: redactSensitiveText(text, { mode: "off", patterns: customStrings }),
    sensitiveFieldStrings: redactSensitiveText(text, { sensitiveFieldPatterns: customStrings }),
    sensitiveFieldRegexes: redactSensitiveText(text, { sensitiveFieldPatterns: customRegexes }),
  };
});

console.log(
  JSON.stringify({
    entryPoint: "openclaw/plugin-sdk/security-runtime#redactSensitiveText",
    results,
  }),
);
