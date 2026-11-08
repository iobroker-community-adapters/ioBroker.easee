"use strict";

export {};

import { expect } from "chai";
import { describe, it } from "mocha";
import {
  getConnectionMode,
  parseBluetoothChargerSettings,
  parseBluetoothChargers,
} from "../lib/connection-mode.ts";

describe("connection mode configuration", () => {
  it("keeps the existing cloud mode as the default and for unknown settings", () => {
    expect(getConnectionMode(undefined)).to.equal("cloud");
    expect(getConnectionMode("unexpected")).to.equal("cloud");
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
    expect(() =>
      parseBluetoothChargerSettings({
        bluetoothChargerList: { serialNumber: "EMX123456", pin: "1234" },
        bluetoothChargers:
          '[{"serialNumber":"EMX654321","pin":"5678","name":"Legacy"}]',
      }),
    ).to.throw("Bluetooth charger configuration must be a list");
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

  it("accepts an empty charger configuration before the first Device Manager entry", () => {
    expect(
      parseBluetoothChargerSettings({
        bluetoothChargerList: [],
        bluetoothChargers: "[]",
      }),
    ).to.deep.equal([]);
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

  it("rejects malformed JSON without echoing secret input", () => {
    expect(() => parseBluetoothChargers('{"pin":"secret-pin"')).to.throw(
      "must be valid JSON",
    );
  });

  it("rejects duplicate serial numbers without exposing PIN values", () => {
    expect(() =>
      parseBluetoothChargers([
        { serialNumber: "EMX123456", pin: "secret-pin", name: "" },
        { serialNumber: "emx123456", pin: "other-secret", name: "" },
      ]),
    ).to.throw("Duplicate Bluetooth charger serial number");
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
