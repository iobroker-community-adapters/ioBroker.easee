"use strict";

export {};

import { expect } from "chai";
import { describe, it } from "mocha";
import { MAX_NODE_TIMEOUT_MS, validateTimeoutMs } from "../lib/timeout.ts";

describe("Node timeout validation", () => {
  it("accepts finite positive values through the Node timer maximum", () => {
    expect(validateTimeoutMs(1, "test timeout")).to.equal(1);
    expect(validateTimeoutMs(MAX_NODE_TIMEOUT_MS, "test timeout")).to.equal(
      MAX_NODE_TIMEOUT_MS,
    );
  });

  it("rejects non-positive, non-finite, and over-limit values", () => {
    for (const value of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "100",
      null,
    ]) {
      expect(() => validateTimeoutMs(value, "test timeout")).to.throw(
        RangeError,
      );
    }
    expect(() =>
      validateTimeoutMs(MAX_NODE_TIMEOUT_MS + 1, "test timeout"),
    ).to.throw(RangeError);
  });

  it("enforces a lower bound when an internal timeout adds overhead", () => {
    const maximumDiscoveryTimeout = MAX_NODE_TIMEOUT_MS - 1000;
    expect(
      validateTimeoutMs(
        maximumDiscoveryTimeout,
        "discovery timeout",
        maximumDiscoveryTimeout,
      ),
    ).to.equal(maximumDiscoveryTimeout);
    expect(() =>
      validateTimeoutMs(
        maximumDiscoveryTimeout + 1,
        "discovery timeout",
        maximumDiscoveryTimeout,
      ),
    ).to.throw(RangeError);
  });
});
