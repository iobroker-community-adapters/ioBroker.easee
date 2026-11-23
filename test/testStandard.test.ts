"use strict";

export {};

import { expect } from "chai";
import { describe, it } from "mocha";
import { handleStandardCommand } from "../src/lib/standard.ts";
import type { StandardCharger, StandardTarget } from "../src/lib/standard.ts";

/** A fake instance: records the calls of charge and setCurrent */
function fakeTarget(
  chargers: StandardCharger[],
  options: { error?: Error; delayMs?: number } = {},
): StandardTarget & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const run = async (call: unknown[]): Promise<void> => {
    calls.push(call);
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    if (options.error) {
      throw options.error;
    }
  };
  return {
    calls,
    chargers: () => Promise.resolve(chargers),
    charge: (id, on) => run(["charge", id, on]),
    setCurrent: (id, amps) => run(["setCurrent", id, amps]),
    warn: (text) => calls.push(["warn", text]),
  };
}

const garage = { id: "EH123456", name: "Garage" };
const carport = { id: "EH654321", name: "Carport left" };

describe("standard commands (vehicle.*)", () => {
  it("getVehicles lists the chargers as wallboxes", async () => {
    const answer = await handleStandardCommand(
      fakeTarget([garage, carport]),
      "getVehicles",
      {},
    );
    expect(answer).to.deep.equal({
      vehicles: [
        { id: "EH123456", name: "Garage", kind: "wallbox" },
        { id: "EH654321", name: "Carport left", kind: "wallbox" },
      ],
    });
  });

  it("maps vehicle, on and amps to the charger functions", async () => {
    const target = fakeTarget([garage, carport]);
    expect(
      await handleStandardCommand(target, "charge", {
        vehicle: "garage",
        on: true,
      }),
    ).to.deep.equal({ ok: true });
    await handleStandardCommand(target, "charge", {
      vehicle: "eh654321",
      on: "false",
    });
    await handleStandardCommand(target, "setChargeCurrent", {
      vehicle: "carport",
      amps: "16",
    });
    await handleStandardCommand(target, "setChargeCurrent", {
      vehicle: "Garage",
      amps: 0,
    });
    expect(target.calls).to.deep.equal([
      ["charge", "EH123456", true],
      ["charge", "EH654321", false],
      ["setCurrent", "EH654321", 16],
      ["setCurrent", "EH123456", 0],
    ]);
  });

  it("takes the only charger without vehicle; several or unknown are errors", async () => {
    const one = fakeTarget([garage]);
    await handleStandardCommand(one, "charge", { on: true });
    expect(one.calls).to.deep.equal([["charge", "EH123456", true]]);

    const two = fakeTarget([garage, carport]);
    const several = await handleStandardCommand(two, "charge", { on: true });
    expect(several.reason).to.equal("AMBIGUOUS");
    expect(several.candidates).to.deep.equal(["Garage", "Carport left"]);
    const unknown = await handleStandardCommand(two, "charge", {
      vehicle: "Tesla",
      on: true,
    });
    expect(unknown.reason).to.equal("NOT_FOUND");
    const none = await handleStandardCommand(fakeTarget([]), "charge", {
      on: true,
    });
    expect(none.reason).to.equal("NOT_FOUND");
    expect(two.calls).to.deep.equal([]);
  });

  it("refuses missing or wrong parameters without calling the charger", async () => {
    const target = fakeTarget([garage]);
    for (const [command, message] of [
      ["charge", {}],
      ["charge", { on: "yes" }],
      ["setChargeCurrent", {}],
      ["setChargeCurrent", { amps: -1 }],
      ["setChargeCurrent", { amps: "fast" }],
    ] as const) {
      const answer = await handleStandardCommand(target, command, message);
      expect(answer.reason, command).to.equal("BAD_REQUEST");
    }
    expect(target.calls).to.deep.equal([]);
  });

  it("answers the error of the charger with its code", async () => {
    const offline = Object.assign(new Error("not connected"), {
      code: "NOT_CONNECTED",
    });
    expect(
      await handleStandardCommand(
        fakeTarget([garage], { error: offline }),
        "charge",
        { on: true },
      ),
    ).to.deep.equal({ error: "not connected", reason: "NOT_CONNECTED" });
    expect(
      await handleStandardCommand(
        fakeTarget([garage], { error: new Error("HTTP 400") }),
        "setChargeCurrent",
        { amps: 10 },
      ),
    ).to.deep.equal({ error: "HTTP 400", reason: "COMMAND_FAILED" });
  });

  it("answers pending when the charger takes long, and logs a late failure", async () => {
    const target = fakeTarget([garage], {
      delayMs: 50,
      error: new Error("timeout of the Cloud"),
    });
    const answer = await handleStandardCommand(
      target,
      "charge",
      { on: false },
      10,
    );
    expect(answer).to.deep.equal({ ok: true, pending: true });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(target.calls.at(-1)).to.deep.equal([
      "warn",
      "charge Garage: timeout of the Cloud",
    ]);
  });
});
