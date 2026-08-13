import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { encodeProviderSubmission } from "../src/runtime/service.js";

describe("provider submission framing", () => {
  it("sends Enter as a distinct delayed PTY frame", () => {
    const submission = encodeProviderSubmission("hello");

    expect(submission.frames.map((frame) => Buffer.from(frame, "base64").toString())).toEqual(["hello", "\r"]);
    expect(submission.delaysMs[0]).toBe(0);
    expect(submission.delaysMs[1]).toBeGreaterThan(0);
  });

  it("defuses composer mode prefixes with a leading space", () => {
    for (const body of ["!task add BUG: late effects", "/compact now", "# remember this"]) {
      const submission = encodeProviderSubmission(body);
      expect(Buffer.from(submission.frames[0]!, "base64").toString()).toBe(` ${body}`);
    }
  });

  it("leaves ordinary bodies untouched", () => {
    for (const body of ["@mycelia-operator hello!", "plain text", "task add without bang"]) {
      const submission = encodeProviderSubmission(body);
      expect(Buffer.from(submission.frames[0]!, "base64").toString()).toBe(body);
    }
  });
});
