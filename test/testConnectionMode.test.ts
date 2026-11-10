"use strict";

export {};

import { expect } from "chai";
import { describe, it } from "mocha";
import {
  BluetoothConfigurationError,
  getConnectionMode,
  parseBluetoothChargerSettings,
  parseBluetoothChargers,
} from "../src/lib/connection-mode.ts";

function captureConfigurationError(
  action: () => unknown,
): BluetoothConfigurationError {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).to.be.instanceOf(BluetoothConfigurationError);
  return error as BluetoothConfigurationError;
}

describe("connection mode configuration", () => {
  it("keeps the existing cloud mode as the default and for unknown settings", () => {
    expect(getConnectionMode(undefined)).to.equal("cloud");
    expect(getConnectionMode("unexpected")).to.equal("cloud");
  });

  it("exposes a typed bilingual error with its source", () => {
    const error = new BluetoothConfigurationError(
      "Safe English message",
      "Sichere deutsche Meldung",
      "stored",
    );
    expect(error).to.be.instanceOf(Error);
    expect(error.source).to.equal("stored");
    expect(error.message).to.equal("Safe English message");
    expect(error.messageDe).to.equal("Sichere deutsche Meldung");
  });

  it("selects Bluetooth only when explicitly configured", () => {
    expect(getConnectionMode("bluetooth")).to.equal("bluetooth");
  });

  it("validates and normalizes multiple configured chargers", () => {
    expect(
      parseBluetoothChargers([
        { serialNumber: "EMX123456", pin: "1234", name: "" },
        { serialNumber: "EMX654321", pin: "5678", name: "Garage" },
      ]),
    ).to.deep.equal([
      { serialNumber: "EMX123456", pin: "1234", name: "EMX123456" },
      { serialNumber: "EMX654321", pin: "5678", name: "Garage" },
    ]);
  });

  it("parses the canonical charger list from adapter configuration", () => {
    expect(
      parseBluetoothChargerSettings({
        bluetoothChargerList: [
          { serialNumber: "EMX123456", pin: "1234", name: "Garage" },
          { serialNumber: "EMX654321", pin: "5678", name: "" },
        ],
      }),
    ).to.deep.equal([
      { serialNumber: "EMX123456", pin: "1234", name: "Garage" },
      { serialNumber: "EMX654321", pin: "5678", name: "EMX654321" },
    ]);
  });

  it("accepts an empty canonical list before the first Device Manager entry", () => {
    expect(
      parseBluetoothChargerSettings({ bluetoothChargerList: [] }),
    ).to.deep.equal([]);
    expect(parseBluetoothChargerSettings({})).to.deep.equal([]);
  });

  it("rejects a serialized string instead of the canonical list", () => {
    const storedJson = '[{"serialNumber":"SERIAL_SECRET","pin":"PIN_SECRET"}]';
    const error = captureConfigurationError(() =>
      parseBluetoothChargerSettings({ bluetoothChargerList: storedJson }),
    );
    expect(error.source).to.equal("stored");
    expect(error.message).to.contain("bluetoothChargerList");
    expect(error.message).to.contain("must be a list");
    expect(error.message).not.to.contain("SERIAL_SECRET");
    expect(error.message).not.to.contain("PIN_SECRET");
    expect(error.messageDe).not.to.contain("PIN_SECRET");
  });

  it("rejects serialized input without echoing submitted values", () => {
    const submittedJson = '{"serialNumber":"SERIAL_SECRET","pin":"PIN_SECRET"';
    const error = captureConfigurationError(() =>
      parseBluetoothChargers(submittedJson),
    );
    expect(error.source).to.equal("input");
    expect(error.message).to.contain("bluetoothChargerList");
    expect(error.message).to.contain("must be a list");
    expect(error.message).not.to.contain(submittedJson);
    expect(error.message).not.to.contain("SERIAL_SECRET");
    expect(error.messageDe).not.to.contain("PIN_SECRET");
  });

  it("identifies the invalid input entry and field without echoing values", () => {
    const serial = "SERIAL_SECRET_8472";
    const pin = "PIN_SECRET_8472";
    const error = captureConfigurationError(() =>
      parseBluetoothChargers([{ serialNumber: `${serial}!`, pin }]),
    );
    expect(error.source).to.equal("input");
    expect(error.message).to.contain("entry 1");
    expect(error.message).to.contain("serialNumber");
    expect(error.message).not.to.contain(serial);
    expect(error.message).not.to.contain(pin);
    expect(error.messageDe).not.to.contain(serial);
    expect(error.messageDe).not.to.contain(pin);
  });

  it("identifies stored list entries without echoing their values", () => {
    const serial = "STORED_SERIAL_SECRET";
    const pin = "STORED_PIN_SECRET";
    const error = captureConfigurationError(() =>
      parseBluetoothChargerSettings({
        bluetoothChargerList: [{ serialNumber: `${serial}!`, pin }],
      }),
    );
    expect(error.source).to.equal("stored");
    expect(error.message).to.contain("bluetoothChargerList");
    expect(error.message).to.contain("entry 1");
    expect(error.message).to.contain("serialNumber");
    expect(error.message).not.to.contain(serial);
    expect(error.messageDe).not.to.contain(pin);
  });

  it("identifies invalid stored fields and preserves the stored source", () => {
    const encryptedPin = "encrypted-secret-pin";
    const error = captureConfigurationError(() =>
      parseBluetoothChargerSettings({
        bluetoothChargerList: [
          { serialNumber: "EMX123456", pin: { encrypted: encryptedPin } },
        ],
      }),
    );
    expect(error.source).to.equal("stored");
    expect(error.message).to.contain("Stored");
    expect(error.message).to.contain("entry 1");
    expect(error.message).to.contain("pin");
    expect(error.message).not.to.contain(encryptedPin);
    expect(error.messageDe).not.to.contain(encryptedPin);
  });

  it("rejects duplicate serial numbers without exposing serials, PINs, or keys", () => {
    const serial = "EMX_SECRET_123";
    const pin = "PIN_SECRET_123";
    const encryptedPin = "ENCRYPTED_PIN_SECRET_123";
    const submittedChargers = [
      { serialNumber: serial, pin, encryptedPin, key: "key-secret" },
      { serialNumber: serial.toLowerCase(), pin: "second-pin-secret" },
    ];
    const error = captureConfigurationError(() =>
      parseBluetoothChargers(submittedChargers),
    );
    expect(error.source).to.equal("input");
    expect(error.message).to.contain("entry 2");
    expect(error.message).to.contain("serialNumber");
    for (const secret of [
      serial,
      pin,
      encryptedPin,
      "key-secret",
      "second-pin-secret",
      JSON.stringify(submittedChargers),
    ]) {
      expect(error.message).not.to.contain(secret);
      expect(error.messageDe).not.to.contain(secret);
      expect(error.stack).not.to.contain(secret);
    }
  });

  it("rejects incomplete Bluetooth configuration", () => {
    expect(() => parseBluetoothChargers([])).to.throw(
      "Configure at least one Bluetooth charger",
    );
    expect(() =>
      parseBluetoothChargers([
        { serialNumber: "EMX123456", pin: "", name: "" },
      ]),
    ).to.throw("needs a Bluetooth PIN");
  });
});
