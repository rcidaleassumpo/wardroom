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
});
