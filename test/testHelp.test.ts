"use strict";

export {};

import { expect } from "chai";
import { describe, it } from "mocha";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { COMMANDS, HELP } from "../src/lib/help.ts";
import { STANDARD_COMMANDS } from "../src/lib/standard.ts";

/** The commands of onMessage in main.ts and of the device manager of `@iobroker/dm-utils` */
function handledCommands(): string[] {
  const main = fs.readFileSync(
    path.join(__dirname, "..", "src", "main.ts"),
    "utf8",
  );
  const start = main.indexOf("  onMessage(message: ioBroker.Message): void {");
  const end = main.indexOf("\n  }\n", start);
  expect(start).to.be.greaterThan(0);
  const commands = [
    ...main.slice(start, end).matchAll(/message\.command === "([^"]+)"/g),
  ].map((m) => m[1]);
  // the standard commands are answered through STANDARD_COMMANDS
  expect(main.slice(start, end)).to.include(
    "STANDARD_COMMANDS, message.command",
  );
  commands.push(...Object.keys(STANDARD_COMMANDS));

  const dmFile = path.join(
    path.dirname(createRequire(__filename).resolve("@iobroker/dm-utils")),
    "DeviceManagement.js",
  );
  const dm = fs.readFileSync(dmFile, "utf8");
  commands.push(...[...dm.matchAll(/case '(dm:[^']+)':/g)].map((m) => m[1]));
  return commands;
}

describe("help", () => {
  it("lists exactly the commands the instance answers, each once", () => {
    const listed = COMMANDS.map((c) => c.command);
    expect(new Set(listed).size).to.equal(listed.length);
    expect([...listed].sort()).to.deep.equal(
      [...new Set(handledCommands())].sort(),
    );
  });

  it("names every command and the control states", () => {
    for (const { command } of COMMANDS.filter((c) => c.command !== "help")) {
      expect(HELP).to.include(command);
    }
    for (const word of ["control.start", "control.stop", "control.pause"]) {
      expect(HELP).to.include(word);
    }
  });

  it("marks the standard commands of the shared catalog", () => {
    const marked = Object.fromEntries(
      COMMANDS.filter((c) => c.standard).map((c) => [c.command, c.standard]),
    );
    expect(marked).to.deep.equal(STANDARD_COMMANDS);
    for (const { command, write, standard } of COMMANDS.filter(
      (c) => c.standard,
    )) {
      expect(standard, command).to.equal(`vehicle.${command}`);
      expect(write, command).to.equal(command !== "getVehicles");
    }
  });

  it("keeps the lines short", () => {
    for (const line of HELP.split("\n")) {
      expect(line.length, line).to.be.at.most(120);
    }
  });
});
