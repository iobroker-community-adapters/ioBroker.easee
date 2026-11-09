"use strict";

export {};

import { expect } from "chai";
import { describe, it } from "mocha";
import {
  BluetoothConfigurationError,
  getConnectionMode,
  parseBluetoothChargerSettings,
  parseBluetoothChargers,
} from "../lib/connection-mode.ts";

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

  it("parses the encrypted JSON string used by the Admin configuration", () => {
    expect(
      parseBluetoothChargers(
        '[{"serialNumber":"EMX123456","pin":"1234","name":"Garage"}]',
      ),
    ).to.deep.equal([
      { serialNumber: "EMX123456", pin: "1234", name: "Garage" },
    ]);
  });

  it("parses separate serial, PIN and name fields for multiple chargers", () => {
    expect(
      parseBluetoothChargerSettings({
        bluetoothCharger1SerialNumber: "EMX123456",
        bluetoothCharger1Pin: "1234",
        bluetoothCharger1Name: "Garage",
        bluetoothCharger2SerialNumber: "EMX654321",
        bluetoothCharger2Pin: "5678",
        bluetoothCharger2Name: "",
        bluetoothChargers: "[]",
      }),
    ).to.deep.equal([
      { serialNumber: "EMX123456", pin: "1234", name: "Garage" },
      { serialNumber: "EMX654321", pin: "5678", name: "EMX654321" },
    ]);
  });

  it("parses the managed charger list from adapter configuration", () => {
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

  it("prefers the managed charger list over legacy settings", () => {
    expect(
      parseBluetoothChargerSettings({
        bluetoothChargerList: [
          { serialNumber: "EMX654321", pin: "5678", name: "New charger" },
        ],
        bluetoothCharger1SerialNumber: "EMX123456",
        bluetoothCharger1Pin: "1234",
        bluetoothChargers:
          '[{"serialNumber":"EMX789012","pin":"9012","name":"Legacy"}]',
      }),
    ).to.deep.equal([
      { serialNumber: "EMX654321", pin: "5678", name: "New charger" },
    ]);
  });

  it("rejects malformed managed charger data without falling back to legacy values", () => {
    const error = captureConfigurationError(() =>
      parseBluetoothChargerSettings({
        bluetoothChargerList: { serialNumber: "EMX123456", pin: "1234" },
        bluetoothChargers:
          '[{"serialNumber":"EMX654321","pin":"5678","name":"Legacy"}]',
      }),
    );
    expect(error.source).to.equal("stored");
    expect(error.message).to.contain("bluetoothChargerList");
    expect(error.message).to.contain("must be a list");
  });

  it("continues using existing legacy settings while the managed list is empty", () => {
    expect(
      parseBluetoothChargerSettings({
        bluetoothChargerList: [],
        bluetoothCharger1SerialNumber: "EMX123456",
        bluetoothCharger1Pin: "1234",
        bluetoothCharger1Name: "Existing charger",
        bluetoothChargers: "[]",
      }),
    ).to.deep.equal([
      {
        serialNumber: "EMX123456",
        pin: "1234",
        name: "Existing charger",
      },
    ]);
  });

  it("accepts an empty managed list before the first Device Manager entry", () => {
    expect(
      parseBluetoothChargerSettings({
        bluetoothChargerList: [],
        bluetoothChargerListManaged: true,
        bluetoothChargers: "malformed stale legacy data",
      }),
    ).to.deep.equal([]);
  });

  it("accepts empty or unset legacy configuration", () => {
    expect(parseBluetoothChargerSettings({})).to.deep.equal([]);
    expect(
      parseBluetoothChargerSettings({ bluetoothChargers: "[]" }),
    ).to.deep.equal([]);
  });

  it("parses a JSON-array string in the managed list setting", () => {
    expect(
      parseBluetoothChargerSettings({
        bluetoothChargerList:
          '[{"serialNumber":"EMX123456","pin":"1234","name":"Garage"}]',
      }),
    ).to.deep.equal([
      { serialNumber: "EMX123456", pin: "1234", name: "Garage" },
    ]);
  });

  it("keeps reading the encrypted legacy JSON setting when form fields are empty", () => {
    expect(
      parseBluetoothChargerSettings({
        bluetoothChargerList: [],
        bluetoothCharger1SerialNumber: "",
        bluetoothCharger1Pin: "",
        bluetoothChargers:
          '[{"serialNumber":"EMX123456","pin":"1234","name":"Garage"}]',
      }),
    ).to.deep.equal([
      { serialNumber: "EMX123456", pin: "1234", name: "Garage" },
    ]);
  });

  it("rejects incomplete individual charger fields", () => {
    expect(() =>
      parseBluetoothChargerSettings({
        bluetoothCharger1SerialNumber: "EMX123456",
        bluetoothCharger1Pin: "",
        bluetoothChargers: "[]",
      }),
    ).to.throw("needs a Bluetooth PIN");
  });

  it("rejects malformed JSON as input without echoing submitted values", () => {
    const submittedJson = '{"serialNumber":"SERIAL_SECRET","pin":"PIN_SECRET"';
    const error = captureConfigurationError(() =>
      parseBluetoothChargers(submittedJson),
    );
    expect(error.source).to.equal("input");
    expect(error.message).to.contain("bluetoothChargerList");
    expect(error.message).to.contain("must be valid JSON");
    expect(error.messageDe).to.contain("gültiges JSON");
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
        bluetoothCharger1SerialNumber: "EMX123456",
        bluetoothCharger1Pin: { encrypted: encryptedPin },
      }),
    );
    expect(error.source).to.equal("stored");
    expect(error.message).to.contain("Stored");
    expect(error.message).to.contain("entry 1");
    expect(error.message).to.contain("bluetoothCharger1Pin");
    expect(error.message).not.to.contain(encryptedPin);
    expect(error.messageDe).not.to.contain(encryptedPin);
  });

  it("rejects duplicate serial numbers without exposing serials, PINs, or keys", () => {
    const serial = "EMX_SECRET_123";
    const pin = "PIN_SECRET_123";
    const encryptedPin = "ENCRYPTED_PIN_SECRET_123";
    const submittedJson = JSON.stringify([
      { serialNumber: serial, pin, encryptedPin, key: "key-secret" },
      { serialNumber: serial.toLowerCase(), pin: "second-pin-secret" },
    ]);
    const error = captureConfigurationError(() =>
      parseBluetoothChargers(submittedJson),
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
      submittedJson,
    ]) {
      expect(error.message).not.to.contain(secret);
      expect(error.messageDe).not.to.contain(secret);
      expect(error.stack).not.to.contain(secret);
    }
  });

  it("identifies malformed nonempty stored JSON without exposing its payload", () => {
    const storedJson = '{"encryptedPin":"stored-ciphertext-secret"';
    const error = captureConfigurationError(() =>
      parseBluetoothChargerSettings({ bluetoothChargers: storedJson }),
    );
    expect(error.source).to.equal("stored");
    expect(error.message).to.contain("bluetoothChargers");
    expect(error.message).to.contain("must be valid JSON");
    expect(error.message).not.to.contain(storedJson);
    expect(error.message).not.to.contain("stored-ciphertext-secret");
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
