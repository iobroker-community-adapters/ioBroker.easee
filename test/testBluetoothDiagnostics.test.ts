"use strict";

export {};

import { expect } from "chai";
import { describe, it } from "mocha";
import { logBluetoothDiagnostic } from "../lib/bluetooth-diagnostics.ts";

describe("Bluetooth diagnostics privacy", () => {
  it("uses fixed error categories and does not log generic error details", () => {
    const messages: string[] = [];
    const error = new Error(
      "Unexpected failure for EMX12345 with PIN 1234 and payload SECRET-DATA",
    );
    Object.assign(error, { code: "SECRET-CODE", status: 1234 });

    logBluetoothDiagnostic(
      { debug: (message) => messages.push(message) },
      "test.exchange",
      "failed",
      { error },
    );

    expect(messages[0]).to.include("errorCategory=generic");
    expect(messages[0]).to.include("errorName=Error");
    expect(messages[0]).not.to.include("EMX12345");
    expect(messages[0]).not.to.include("1234");
    expect(messages[0]).not.to.include("SECRET");
  });

  it("classifies HCI connection identifier failures without logging their message", () => {
    const messages: string[] = [];

    logBluetoothDiagnostic(
      { debug: (message) => messages.push(message) },
      "transport.link_connect",
      "failed",
      { error: new Error("Unknown Connection Identifier (0x2)") },
    );

    expect(messages[0]).to.include(
      "errorCategory=hci_unknown_connection_identifier",
    );
    expect(messages[0]).not.to.include("Unknown Connection Identifier");
  });

  it("classifies ATT notification errors without including their message", () => {
    const messages: string[] = [];

    logBluetoothDiagnostic(
      { debug: (message) => messages.push(message) },
      "transport.characteristic_data",
      "accepted",
      {
        error: new Error("ATT notification failed for EMX12345, PIN 1234"),
        fields: { channel: "hello", byteLength: 3, isNotification: true },
      },
    );

    expect(messages[0]).to.include("errorCategory=att_notification_error");
    expect(messages[0]).not.to.include("EMX12345");
    expect(messages[0]).not.to.include("1234");
  });
});
