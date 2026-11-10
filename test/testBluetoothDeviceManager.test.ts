"use strict";

export {};

import { expect } from "chai";
import sinon from "sinon";
import Module from "node:module";
import type { Module as NodeModule } from "node:module";
import { afterEach, describe, it } from "mocha";
import type { DeviceInfo } from "@iobroker/dm-utils";

interface ModuleLoader {
  _load: (
    request: string,
    parent: NodeModule | undefined,
    isMain: boolean,
  ) => unknown;
}

interface TestAction {
  id: string;
  handler?: (...args: unknown[]) => unknown;
}

interface TestInstanceInfo {
  apiVersion: string;
  actions?: TestAction[];
}

interface TestDeviceInfo {
  actions?: TestAction[];
}

const moduleLoader = Module as unknown as ModuleLoader;
const originalLoad = moduleLoader._load;
moduleLoader._load = function (
  request: string,
  parent: NodeModule | undefined,
  isMain: boolean,
) {
  if (request === "@iobroker/adapter-core") {
    return { Adapter: class {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const createAdapter = require("../main.ts");
moduleLoader._load = originalLoad;

const BluetoothDeviceManager = createAdapter.EaseeBluetoothDeviceManagement;

class TestDeviceManagement extends BluetoothDeviceManager {
  constructor(adapter: Record<string, unknown>) {
    super(adapter);
  }

  getInfo(): TestInstanceInfo {
    return this.getInstanceInfo() as TestInstanceInfo;
  }

  getDevices(): DeviceInfo<string>[] {
    const devices: DeviceInfo<string>[] = [];
    let totalDevices = 0;
    this.loadDevices({
      setTotalDevices: (count: number) => {
        totalDevices = count;
      },
      addDevice: (device: DeviceInfo<string>) => devices.push(device),
    });
    expect(totalDevices).to.equal(devices.length);
    return devices;
  }

  getDevice(deviceId: string): TestDeviceInfo {
    return this.getDeviceInfo(deviceId) as TestDeviceInfo;
  }

  debugLog(message: string): void {
    this.log.debug(message);
  }
}

function createHarness(initialConfig: Record<string, unknown> = {}): {
  adapter: ReturnType<typeof Object.create>;
  manager: TestDeviceManagement;
  storedObject: { native: Record<string, unknown> };
} {
  const adapter = Object.create(createAdapter.Easee.prototype);
  adapter.on = sinon.stub();
  adapter.log = {
    debug: sinon.stub(),
    error: sinon.stub(),
    info: sinon.stub(),
    warn: sinon.stub(),
  };
  adapter.namespace = "easee.0";
  adapter.config = {
    bluetoothChargerList: [],
    bluetoothChargerListManaged: false,
    bluetoothChargers: "[]",
    ...initialConfig,
  };
  adapter.bluetoothConfigMutation = Promise.resolve();
  adapter.encrypt = sinon
    .stub()
    .callsFake(
      (pin: string) => `encrypted-${Buffer.from(pin).toString("hex")}`,
    );
  adapter.decrypt = sinon
    .stub()
    .callsFake((pin: string) =>
      Buffer.from(pin.replace(/^encrypted-/, ""), "hex").toString(),
    );
  const storedObject = {
    native: {
      ...adapter.config,
      untouchedSetting: "keep me",
    },
  };
  adapter.extendForeignObjectAsync = sinon
    .stub()
    .callsFake((_id: string, object: { native: Record<string, unknown> }) => {
      Object.assign(storedObject.native, object.native);
      return Promise.resolve();
    });
  const manager = new TestDeviceManagement(adapter);
  return { adapter, manager, storedObject };
}

function actionById(actions: TestAction[], id: string): TestAction {
  const action = actions.find((candidate) => candidate.id === id);
  expect(action, `expected action ${id}`).to.exist;
  return action!;
}

describe("Bluetooth charger Device Manager", () => {
  afterEach(() => sinon.restore());

  it("registers Device Manager v3 actions and lists chargers without exposing PINs", () => {
    const { manager } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:encrypted-34333231",
          name: "Garage",
        },
      ],
      bluetoothChargerListManaged: true,
    });
    const devices = manager.getDevices();
    expect(manager.getInfo().apiVersion).to.equal("v3");
    expect(manager.getInfo().actions?.map(({ id }) => id)).to.include(
      "addBluetoothCharger",
    );
    expect(devices).to.have.length(1);
    expect(JSON.stringify(devices)).not.to.include("4321");
    expect(JSON.stringify(devices)).to.include("EMX123456");
  });

  it("shows live power and Bluetooth signal in the card body without controls", () => {
    const { manager } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:encrypted-34333231",
          name: "Garage",
        },
      ],
      bluetoothChargerListManaged: true,
    });

    const [device] = manager.getDevices();
    expect(device.name).to.equal("Garage");
    expect(device.status).to.deep.equal({
      connection: {
        stateId: "easee.0.EMX123456.info.bluetoothConnection",
        mapping: { true: "connected", false: "disconnected" },
      },
    });
    expect(device.customInfo).to.deep.equal({
      id: "EMX123456",
      schema: {
        type: "panel",
        items: {
          totalPower: {
            type: "state",
            oid: "easee.0.EMX123456.status.totalPower",
            foreign: true,
            control: "text",
            label: {
              en: "Charging power",
              de: "Ladeleistung",
              es: "Potencia de carga",
              fr: "Puissance de charge",
              it: "Potenza di ricarica",
              nl: "Laadvermogen",
              pl: "Moc ładowania",
              pt: "Potência de carregamento",
              ru: "Мощность зарядки",
              uk: "Потужність заряджання",
              "zh-cn": "充电功率",
            },
            unit: "kW",
          },
          bluetoothRSSI: {
            type: "state",
            oid: "easee.0.EMX123456.info.bluetoothRSSI",
            foreign: true,
            control: "text",
            label: {
              en: "Bluetooth signal strength",
              de: "Bluetooth-Signalstärke",
              es: "Intensidad de la señal Bluetooth",
              fr: "Intensité du signal Bluetooth",
              it: "Intensità del segnale Bluetooth",
              nl: "Bluetooth-signaalsterkte",
              pl: "Siła sygnału Bluetooth",
              pt: "Intensidade do sinal Bluetooth",
              ru: "Уровень сигнала Bluetooth",
              uk: "Рівень сигналу Bluetooth",
              "zh-cn": "蓝牙信号强度",
            },
            unit: "dBm",
          },
        },
      },
    });
    expect(device.controls).to.be.undefined;
  });

  it("adds a charger, encrypts its PIN, and clears migrated legacy configuration", async () => {
    const { adapter, manager, storedObject } = createHarness({
      bluetoothCharger1SerialNumber: "EMX123456",
      bluetoothCharger1Pin: "1234",
      bluetoothCharger1Name: "Legacy garage",
    });
    const context = {
      showForm: sinon.stub().resolves({
        serialNumber: "EMX654321",
        pin: "5678",
        name: "New charger",
      }),
      showMessage: sinon.stub().resolves(),
    };
    const addAction = actionById(
      manager.getInfo().actions!,
      "addBluetoothCharger",
    );

    expect(await addAction.handler!(context)).to.deep.equal({ refresh: true });
    expect(adapter.encrypt.calledWithExactly("5678")).to.equal(true);
    expect(storedObject.native.bluetoothChargerList).to.deep.equal([
      {
        serialNumber: "EMX123456",
        pin: "easee:v1:encrypted-31323334",
        name: "Legacy garage",
      },
      {
        serialNumber: "EMX654321",
        pin: "easee:v1:encrypted-35363738",
        name: "New charger",
      },
    ]);
    expect(storedObject.native.bluetoothChargers).to.equal("");
    expect(storedObject.native.bluetoothCharger1SerialNumber).to.equal("");
    expect(storedObject.native.bluetoothCharger1Pin).to.equal("");
    expect(storedObject.native.untouchedSetting).to.equal("keep me");
    expect(JSON.stringify(storedObject.native)).not.to.include("5678");
  });

  it("allows adding the first charger to a new empty configuration", async () => {
    const { adapter, manager, storedObject } = createHarness();
    const context = {
      showForm: sinon.stub().resolves({
        serialNumber: "EMX123456",
        pin: "1234",
        name: "",
      }),
      showMessage: sinon.stub().resolves(),
    };
    const add = actionById(manager.getInfo().actions!, "addBluetoothCharger");

    expect(await add.handler!(context)).to.deep.equal({ refresh: true });
    expect(storedObject.native.bluetoothChargerList).to.deep.equal([
      {
        serialNumber: "EMX123456",
        pin: "easee:v1:encrypted-31323334",
        name: "EMX123456",
      },
    ]);
    expect(adapter.encrypt.calledWithExactly("1234")).to.equal(true);
  });

  it("shows a redacted field-specific warning for an undecryptable saved charger", () => {
    const { adapter, manager } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:stored-ciphertext-secret",
          name: "Garage",
        },
      ],
      bluetoothChargerListManaged: true,
    });
    adapter.decrypt.throws(new Error("decrypt-error-secret"));

    const devices = manager.getDevices();
    expect(devices).to.have.length(1);
    expect(devices[0].name).to.deep.include({
      en: "Bluetooth configuration error: Stored Bluetooth charger entry 1 field pin could not be decrypted.",
      de: "Bluetooth-Konfigurationsfehler: Der PIN in Eintrag 1, Feld pin, der gespeicherten Bluetooth-Konfiguration konnte nicht entschlüsselt werden.",
    });
    const output = JSON.stringify({ devices, logs: adapter.log });
    expect(output).not.to.include("stored-ciphertext-secret");
    expect(output).not.to.include("decrypt-error-secret");
  });

  it("reports a stored configuration failure when it blocks the first add", async () => {
    const { adapter, manager } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:stored-ciphertext-secret",
          name: "Garage",
        },
      ],
      bluetoothChargerListManaged: true,
    });
    adapter.decrypt.throws(new Error("decrypt-error-secret"));
    const context = {
      showForm: sinon.stub().resolves({
        serialNumber: "EMX654321",
        pin: "new-submitted-pin",
        name: "New charger",
      }),
      showMessage: sinon.stub().resolves(),
    };
    const add = actionById(manager.getInfo().actions!, "addBluetoothCharger");

    expect(await add.handler!(context)).to.deep.equal({ refresh: false });
    const message = JSON.stringify(context.showMessage.firstCall.args[0]);
    expect(message).to.include(
      "existing stored Bluetooth configuration is invalid",
    );
    expect(message).to.include("entry 1 field pin");
    expect(message).not.to.include("new-submitted-pin");
    expect(message).not.to.include("stored-ciphertext-secret");
    expect(message).not.to.include("decrypt-error-secret");
    expect(adapter.extendForeignObjectAsync.called).to.equal(false);
    expect(adapter.encrypt.called).to.equal(false);
    expect(adapter.log.error.called).to.equal(false);
    expect(adapter.log.warn.called).to.equal(false);
  });

  it("migrates legacy JSON to encrypted canonical storage idempotently", async () => {
    const legacyJson =
      '[{"serialNumber":"EMX123456","pin":"1234","name":"Old JSON charger"}]';
    const { adapter, manager, storedObject } = createHarness({
      bluetoothChargers: legacyJson,
    });
    expect(manager.getDevices().map(({ id }) => id)).to.deep.equal([
      "EMX123456",
    ]);

    await adapter.migrateBluetoothConfiguration();
    expect(storedObject.native.bluetoothChargers).to.equal("");
    expect(storedObject.native.bluetoothChargerListManaged).to.equal(true);
    expect(storedObject.native.bluetoothChargerList).to.deep.equal([
      {
        serialNumber: "EMX123456",
        pin: "easee:v1:encrypted-31323334",
        name: "Old JSON charger",
      },
    ]);
    expect(adapter.extendForeignObjectAsync.calledOnce).to.equal(true);
    await adapter.migrateBluetoothConfiguration();
    expect(adapter.extendForeignObjectAsync.calledOnce).to.equal(true);
    expect(
      adapter
        .getConfiguredBluetoothChargers()
        .map((entry: { serialNumber: string }) => entry.serialNumber),
    ).to.deep.equal(["EMX123456"]);
  });

  it("migrates legacy slots and clears every legacy PIN field", async () => {
    const { adapter, storedObject } = createHarness({
      bluetoothCharger1SerialNumber: "EMX123456",
      bluetoothCharger1Pin: "1234",
      bluetoothCharger1Name: "Legacy slot",
    });

    await adapter.migrateBluetoothConfiguration();

    expect(storedObject.native.bluetoothChargerList).to.deep.equal([
      {
        serialNumber: "EMX123456",
        pin: "easee:v1:encrypted-31323334",
        name: "Legacy slot",
      },
    ]);
    expect(storedObject.native.bluetoothCharger1SerialNumber).to.equal("");
    expect(storedObject.native.bluetoothCharger1Pin).to.equal("");
    expect(storedObject.native.bluetoothCharger1Name).to.equal("");
  });

  it("preserves legacy configuration when canonical migration persistence fails", async () => {
    const legacyJson =
      '[{"serialNumber":"EMX123456","pin":"1234","name":"Old JSON charger"}]';
    const { adapter, storedObject } = createHarness({
      bluetoothChargers: legacyJson,
    });
    const originalStoredNative = { ...storedObject.native };
    adapter.extendForeignObjectAsync.rejects(new Error("save failed"));

    const migrationError = await adapter
      .migrateBluetoothConfiguration()
      .catch((error: unknown) => error);
    expect(migrationError).to.be.instanceOf(Error);
    expect(storedObject.native).to.deep.equal(originalStoredNative);
    expect(adapter.config.bluetoothChargers).to.equal(legacyJson);
    expect(adapter.config.bluetoothChargerListManaged).to.equal(false);
  });

  it("preserves legacy configuration when migration encryption fails", async () => {
    const legacyJson =
      '[{"serialNumber":"EMX123456","pin":"1234","name":"Old JSON charger"}]';
    const { adapter, storedObject } = createHarness({
      bluetoothChargers: legacyJson,
    });
    const originalStoredNative = { ...storedObject.native };
    adapter.encrypt.throws(new Error("encryption failed"));

    const migrationError = await adapter
      .migrateBluetoothConfiguration()
      .catch((error: unknown) => error);
    expect(migrationError).to.be.instanceOf(Error);
    expect(storedObject.native).to.deep.equal(originalStoredNative);
    expect(adapter.config.bluetoothChargers).to.equal(legacyJson);
    expect(adapter.extendForeignObjectAsync.called).to.equal(false);
  });

  it("edits a charger while preserving its encrypted PIN when the field is blank", async () => {
    const { adapter, manager, storedObject } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:encrypted-34333231",
          name: "Old name",
        },
      ],
      bluetoothChargerListManaged: true,
    });
    const device = manager.getDevice("EMX123456");
    const edit = actionById(device.actions!, "editBluetoothCharger");
    const context = {
      showForm: sinon.stub().resolves({
        serialNumber: "EMX123456",
        pin: "",
        name: "Updated name",
      }),
      showMessage: sinon.stub().resolves(),
    };

    expect(await edit.handler!("EMX123456", context)).to.deep.equal({
      refresh: "instance",
    });
    expect(adapter.encrypt.calledWithExactly("4321")).to.equal(true);
    expect(storedObject.native.bluetoothChargerList).to.deep.equal([
      {
        serialNumber: "EMX123456",
        pin: "easee:v1:encrypted-34333231",
        name: "Updated name",
      },
    ]);
  });

  it("removes a charger and permits an explicitly empty managed list", async () => {
    const { manager, adapter, storedObject } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:encrypted-34333231",
          name: "One",
        },
      ],
      bluetoothChargerListManaged: true,
      bluetoothCharger2SerialNumber: "EMX654321",
      bluetoothCharger2Pin: "8765",
    });
    const remove = actionById(
      manager.getDevice("EMX123456").actions!,
      "removeBluetoothCharger",
    );

    expect(
      await remove.handler!("EMX123456", {
        showMessage: sinon.stub().resolves(),
      }),
    ).to.deep.equal({
      refresh: "instance",
    });
    expect(storedObject.native.bluetoothChargerList).to.deep.equal([]);
    expect(storedObject.native.bluetoothChargerListManaged).to.equal(true);
    expect(storedObject.native.bluetoothCharger2Pin).to.equal("");
    expect(adapter.getConfiguredBluetoothChargers()).to.deep.equal([]);
  });

  it("rejects invalid input without echoing or logging the submitted PIN", async () => {
    const { manager, adapter } = createHarness();
    const context = {
      showForm: sinon.stub().resolves({
        serialNumber: "invalid serial",
        pin: "sensitive-pin",
        name: "Bad entry",
      }),
      showMessage: sinon.stub().resolves(),
    };
    const add = actionById(manager.getInfo().actions!, "addBluetoothCharger");

    expect(await add.handler!(context)).to.deep.equal({ refresh: false });
    expect(adapter.extendForeignObjectAsync.called).to.equal(false);
    expect(
      JSON.stringify(context.showMessage.firstCall.args[0]),
    ).not.to.include("sensitive-pin");
    expect(adapter.log.error.called).to.equal(false);
    expect(adapter.log.warn.called).to.equal(false);
  });

  it("suppresses dm-utils debug messages that include submitted form data", () => {
    const { manager, adapter } = createHarness();

    manager.debugLog(
      'DeviceManagement received: {"command":"dm:deviceAction","message":{"pin":"sensitive-pin"}}',
    );

    expect(adapter.log.debug.called).to.equal(false);
  });

  it("rejects a forged device ID and unknown charger without changing configuration", async () => {
    const { manager, adapter } = createHarness({
      bluetoothChargerList: [
        {
          serialNumber: "EMX123456",
          pin: "easee:v1:encrypted-34333231",
          name: "Garage",
        },
      ],
      bluetoothChargerListManaged: true,
    });
    const remove = actionById(
      manager.getDevice("EMX123456").actions!,
      "removeBluetoothCharger",
    );

    expect(await remove.handler!("EMX654321", {})).to.deep.equal({
      refresh: "none",
    });
    expect(() => manager.getDevice("EMX654321")).to.throw(
      "Bluetooth charger is not configured",
    );
    expect(adapter.extendForeignObjectAsync.called).to.equal(false);
  });
});
