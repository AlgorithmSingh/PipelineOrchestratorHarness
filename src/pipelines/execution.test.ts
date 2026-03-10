import { describe, expect, it } from "vitest";
import { parseReviewerVerdict } from "./execution.js";

describe("parseReviewerVerdict", () => {
  it("parses plain pass/fail JSON", () => {
    expect(parseReviewerVerdict('{"verdict":"pass"}')).toMatchObject({ valid: true, verdict: "pass" });
    expect(parseReviewerVerdict('{"verdict":"fail"}')).toMatchObject({ valid: true, verdict: "fail" });
  });

  it("parses fenced JSON with or without language tag", () => {
    const fenced = "```json\n{\"verdict\":\"pass\"}\n```";
    const fencedNoLang = "```\n{\"verdict\":\"fail\"}\n```";
    expect(parseReviewerVerdict(fenced)).toMatchObject({ valid: true, verdict: "pass" });
    expect(parseReviewerVerdict(fencedNoLang)).toMatchObject({ valid: true, verdict: "fail" });
  });

  it("ignores extra fields and uses the first JSON block", () => {
    const output = [
      "prologue",
      "{\"verdict\":\"pass\",\"summary\":\"ok\"}",
      "{\"verdict\":\"fail\"}",
    ].join("\n");
    expect(parseReviewerVerdict(output)).toMatchObject({ valid: true, verdict: "pass" });
  });

  it("returns invalid for wrong verdict casing or type", () => {
    expect(parseReviewerVerdict('{"verdict":"Pass"}')).toMatchObject({ valid: false, reason: "invalid_verdict_value" });
    expect(parseReviewerVerdict('{"verdict":true}')).toMatchObject({ valid: false, reason: "invalid_verdict_value" });
  });

  it("handles missing verdict field", () => {
    expect(parseReviewerVerdict('{"result":"pass"}')).toMatchObject({ valid: false, reason: "missing_verdict_field" });
  });

  it("handles malformed or absent JSON", () => {
    expect(parseReviewerVerdict("not json at all")).toMatchObject({ valid: false, reason: "no_json_found" });
    expect(parseReviewerVerdict("{\"verdict\"")).toMatchObject({ valid: false, reason: "json_parse_error" });
    expect(parseReviewerVerdict("")).toMatchObject({ valid: false, reason: "no_json_found" });
  });

  it("balances nested braces when extracting the JSON object", () => {
    const output = "```\n{\"verdict\":\"fail\",\"details\":{\"nested\":true}}\n```";
    expect(parseReviewerVerdict(output)).toMatchObject({ valid: true, verdict: "fail" });
  });
});
