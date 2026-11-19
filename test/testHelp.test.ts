"use strict";

export {};

import { expect } from "chai";
import { describe, it } from "mocha";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { COMMANDS, HELP } from "../src/lib/help.ts";

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

  it("keeps the lines short", () => {
    for (const line of HELP.split("\n")) {
      expect(line.length, line).to.be.at.most(120);
    }
  });
});
