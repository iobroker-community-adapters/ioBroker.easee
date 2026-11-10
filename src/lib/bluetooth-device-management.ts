"use strict";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { I18n } from "@iobroker/adapter-core";
import type { AdapterInstance } from "@iobroker/adapter-core";
import { DeviceManagement } from "@iobroker/dm-utils";
import type {
  ActionContext,
  DeviceInfo,
  DeviceLoadContext,
  InstanceDetails,
  JsonFormSchema,
} from "@iobroker/dm-utils";
import { BluetoothConfigurationError } from "./connection-mode.ts";
import type {
  BluetoothChargerConfig,
  ConnectionMode,
} from "./connection-mode.ts";

type AdminLanguage =
  "en" | "de" | "ru" | "pt" | "nl" | "fr" | "it" | "es" | "pl" | "uk" | "zh-cn";
type DeviceManagerTextParameter = string | number | ioBroker.StringOrTranslated;

const adminLanguages: readonly AdminLanguage[] = [
  "en",
  "de",
  "ru",
  "pt",
  "nl",
  "fr",
  "it",
  "es",
  "pl",
  "uk",
  "zh-cn",
];
let adminLocaleTranslations:
  Record<AdminLanguage, Record<string, string>> | undefined;

export function getAdminDirectory(): string {
  const candidates = [
    join(__dirname, "admin"),
    join(__dirname, "..", "admin"),
    join(__dirname, "..", "..", "admin"),
  ];
  return (
    candidates.find((candidate) => existsSync(join(candidate, "i18n"))) ??
    candidates[candidates.length - 1]
  );
}

function getAdminLocaleTranslations(): Record<
  AdminLanguage,
  Record<string, string>
> {
  if (!adminLocaleTranslations) {
    const i18nDirectory = join(getAdminDirectory(), "i18n");
    adminLocaleTranslations = Object.fromEntries(
      adminLanguages.map((language) => [
        language,
        JSON.parse(
          readFileSync(join(i18nDirectory, `${language}.json`), "utf8"),
        ) as Record<string, string>,
      ]),
    ) as Record<AdminLanguage, Record<string, string>>;
  }
  return adminLocaleTranslations;
}

function deviceManagerText(
  key: string,
  ...parameters: DeviceManagerTextParameter[]
): ioBroker.StringOrTranslated {
  const translations = getAdminLocaleTranslations();
  const localized = {} as Record<AdminLanguage, string>;
  for (const language of adminLanguages) {
    let text = translations[language][key] ?? translations.en[key] ?? key;
    for (const parameter of parameters) {
      const value =
        typeof parameter === "object" && parameter !== null
          ? ((parameter as Record<AdminLanguage, string>)[language] ??
            (parameter as Record<AdminLanguage, string>).en ??
            "")
          : String(parameter);
      text = text.replace("%s", value);
    }
    localized[language] = text;
  }
  return localized;
}

export function getStoredBluetoothConfigurationError(
  error: unknown,
): BluetoothConfigurationError {
  if (
    error instanceof BluetoothConfigurationError &&
    error.source === "stored"
  ) {
    return error;
  }
  return new BluetoothConfigurationError(
    "Stored Bluetooth charger configuration could not be read.",
    "Die gespeicherte Bluetooth-Konfiguration konnte nicht gelesen werden.",
    "stored",
    {
      type: "message",
      key: "Stored Bluetooth charger configuration could not be read.",
    },
  );
}

function getBluetoothConfigurationErrorText(
  error: BluetoothConfigurationError,
): ioBroker.StringOrTranslated {
  const diagnostic = error.diagnostic;
  if (!diagnostic) {
    return deviceManagerText(
      "Stored Bluetooth charger configuration could not be read.",
    );
  }
  if (diagnostic.type === "message") {
    return deviceManagerText(diagnostic.key, ...(diagnostic.parameters ?? []));
  }

  const { entry, field, setting, reason } = diagnostic;
  let location: ioBroker.StringOrTranslated;
  if (error.source === "stored") {
    if (entry !== undefined && setting && setting !== field) {
      location = deviceManagerText(
        "Stored setting %s, entry %s, field %s",
        setting,
        entry,
        field,
      );
    } else if (entry !== undefined) {
      location = deviceManagerText("Stored entry %s, field %s", entry, field);
    } else {
      location = deviceManagerText("Stored field %s", field);
    }
  } else if (entry !== undefined) {
    location = deviceManagerText(
      "Bluetooth charger entry %s, field %s",
      entry,
      field,
    );
  } else {
    location = deviceManagerText("Bluetooth charger field %s", field);
  }
  return deviceManagerText("%s: %s.", location, deviceManagerText(reason));
}

function getBluetoothDeviceActionErrorMessage(
  error: unknown,
  action: "save" | "remove",
): ioBroker.StringOrTranslated {
  if (error instanceof BluetoothConfigurationError) {
    const details = getBluetoothConfigurationErrorText(error);
    if (error.source === "stored") {
      return action === "save"
        ? deviceManagerText(
            "The charger could not be saved because the existing stored Bluetooth configuration is invalid: %s",
            details,
          )
        : deviceManagerText(
            "The charger could not be removed because the existing stored Bluetooth configuration is invalid: %s",
            details,
          );
    }
    return deviceManagerText(
      "The submitted Bluetooth charger data is invalid: %s",
      details,
    );
  }
  return action === "save"
    ? deviceManagerText(
        "The charger could not be saved. Check the serial number, PIN, and duplicate chargers.",
      )
    : deviceManagerText(
        "The charger could not be removed from the configuration.",
      );
}

export interface BluetoothDeviceManagementHost extends AdapterInstance {
  readonly connectionMode: ConnectionMode;
  getConfiguredBluetoothChargers(): BluetoothChargerConfig[];
  addBluetoothCharger(value: unknown): Promise<void>;
  editBluetoothCharger(serialNumber: string, value: unknown): Promise<void>;
  removeBluetoothCharger(serialNumber: string): Promise<void>;
  resetBluetoothChargerConfiguration(): Promise<void>;
}

const bluetoothChargerFormSchema = {
  type: "panel",
  items: {
    serialNumber: {
      type: "text",
      label: {
        en: "Serial number",
        de: "Seriennummer",
        ru: "Серийный номер",
        pt: "Número de série",
        nl: "Serienummer",
        fr: "Numéro de série",
        it: "Numero di serie",
        es: "Número de serie",
        pl: "Numer seryjny",
        uk: "Серійний номер",
        "zh-cn": "序列号",
      },
      validator:
        "!!data.serialNumber && /^[A-Za-z0-9_-]+$/.test(data.serialNumber)",
    },
    pin: {
      type: "password",
      label: {
        en: "Bluetooth PIN",
        de: "Bluetooth-PIN",
        ru: "PIN Bluetooth",
        pt: "PIN do Bluetooth",
        nl: "Bluetooth-pincode",
        fr: "Code PIN Bluetooth",
        it: "PIN Bluetooth",
        es: "PIN de Bluetooth",
        pl: "PIN Bluetooth",
        uk: "PIN Bluetooth",
        "zh-cn": "蓝牙 PIN",
      },
      help: {
        en: "Leave empty to keep the current PIN when editing.",
        de: "Leer lassen, um die aktuelle PIN beim Bearbeiten beizubehalten.",
        ru: "Оставьте поле пустым, чтобы сохранить текущий PIN при редактировании.",
        pt: "Deixe vazio para manter o PIN atual ao editar.",
        nl: "Laat leeg om de huidige pincode te behouden bij bewerken.",
        fr: "Laissez vide pour conserver le code PIN actuel lors de la modification.",
        it: "Lascia vuoto per mantenere il PIN attuale durante la modifica.",
        es: "Déjelo vacío para conservar el PIN actual al editar.",
        pl: "Pozostaw puste, aby zachować obecny PIN podczas edycji.",
        uk: "Залиште порожнім, щоб зберегти поточний PIN під час редагування.",
        "zh-cn": "编辑时留空可保留当前 PIN。",
      },
    },
    name: {
      type: "text",
      label: {
        en: "Charger name (optional)",
        de: "Wallbox-Name (optional)",
        ru: "Имя зарядного устройства (необязательно)",
        pt: "Nome do carregador (opcional)",
        nl: "Naam van de lader (optioneel)",
        fr: "Nom du chargeur (facultatif)",
        it: "Nome del caricatore (opzionale)",
        es: "Nombre del cargador (opcional)",
        pl: "Nazwa ładowarki (opcjonalnie)",
        uk: "Назва зарядного пристрою (необов’язково)",
        "zh-cn": "充电器名称（可选）",
      },
    },
  },
} as JsonFormSchema;

export class EaseeBluetoothDeviceManagement extends DeviceManagement<
  BluetoothDeviceManagementHost,
  string
> {
  protected get log(): ioBroker.Logger {
    const logger = this.adapter.log;
    return {
      level: logger.level,
      silly: (message) => logger.silly(message),
      debug: (message) => {
        if (!message.startsWith("DeviceManagement received:")) {
          logger.debug(message);
        }
      },
      info: (message) => logger.info(message),
      warn: (message) => logger.warn(message),
      error: (message) => logger.error(message),
    };
  }

  protected getInstanceInfo(): InstanceDetails {
    return {
      apiVersion: "v3" as const,
      actions: [
        {
          id: "addBluetoothCharger",
          icon: "newDevice",
          title: deviceManagerText("Add Bluetooth charger"),
          handler: async (context: ActionContext) => {
            const form = await context.showForm(bluetoothChargerFormSchema, {
              title: deviceManagerText("Add Bluetooth charger"),
              buttons: ["apply", "cancel"],
            });
            if (!form) {
              return { refresh: false };
            }
            try {
              await this.adapter.addBluetoothCharger(form);
            } catch (error) {
              await context.showMessage(
                getBluetoothDeviceActionErrorMessage(error, "save"),
              );
              return { refresh: false };
            }
            await context.showMessage(
              deviceManagerText(
                "Charger saved. Restart the adapter to apply the change.",
              ),
            );
            return { refresh: true };
          },
        },
      ],
    };
  }

  protected loadDevices(context: DeviceLoadContext<string>): void {
    let chargers: BluetoothChargerConfig[];
    try {
      chargers = this.adapter.getConfiguredBluetoothChargers();
    } catch (error) {
      const configurationError = getStoredBluetoothConfigurationError(error);
      context.setTotalDevices(1);
      context.addDevice({
        id: "__bluetooth-configuration-error__",
        name: deviceManagerText(
          "Bluetooth configuration error: %s",
          getBluetoothConfigurationErrorText(configurationError),
        ),
        connectionType: "bluetooth",
        status: { connection: "disconnected", warning: true },
        actions: [
          {
            id: "resetBluetoothChargerConfiguration",
            icon: "delete",
            title: deviceManagerText("Clear configuration"),
            confirmation: deviceManagerText(
              "This clears all saved Bluetooth chargers and PINs. Continue?",
            ),
            handler: async (deviceId, actionContext) => {
              if (deviceId !== "__bluetooth-configuration-error__") {
                return { refresh: "none" };
              }
              try {
                await this.adapter.resetBluetoothChargerConfiguration();
              } catch {
                await actionContext.showMessage(
                  deviceManagerText(
                    "Could not clear the stored Bluetooth configuration.",
                  ),
                );
                return { refresh: "none" };
              }
              await actionContext.showMessage(
                deviceManagerText(
                  "Bluetooth configuration cleared. Add chargers again in the Device Manager and restart the adapter.",
                ),
              );
              return { refresh: "instance" };
            },
          },
        ],
      });
      return;
    }
    context.setTotalDevices(chargers.length);
    for (const charger of chargers) {
      context.addDevice(this.getChargerInfo(charger));
    }
  }

  protected getDeviceInfo(deviceId: string): DeviceInfo<string> {
    let charger: BluetoothChargerConfig | undefined;
    try {
      charger = this.adapter
        .getConfiguredBluetoothChargers()
        .find((item) => item.serialNumber === deviceId);
    } catch (error) {
      throw getStoredBluetoothConfigurationError(error);
    }
    if (!charger) {
      throw new Error(I18n.t("Bluetooth charger is not configured."));
    }
    return this.getChargerInfo(charger);
  }

  private getChargerInfo(charger: BluetoothChargerConfig): DeviceInfo<string> {
    const serialNumber = charger.serialNumber;
    return {
      id: serialNumber,
      identifier: serialNumber,
      name: charger.name || serialNumber,
      connectionType: "bluetooth",
      status: {
        connection: {
          stateId: `${this.adapter.namespace}.${serialNumber}.info.bluetoothConnection`,
          mapping: { true: "connected", false: "disconnected" },
        },
      },
      customInfo: {
        id: serialNumber,
        schema: {
          type: "panel",
          items: {
            totalPower: {
              type: "state",
              oid: `${this.adapter.namespace}.${serialNumber}.status.totalPower`,
              foreign: true,
              control: "text",
              digits: 2,
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
              oid: `${this.adapter.namespace}.${serialNumber}.info.bluetoothRSSI`,
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
      },
      actions: [
        {
          id: "editBluetoothCharger",
          icon: "edit",
          title: deviceManagerText("Edit"),
          handler: async (deviceId, context) => {
            if (deviceId !== serialNumber) {
              return { refresh: "none" };
            }
            const form = await context.showForm(bluetoothChargerFormSchema, {
              title: deviceManagerText("Edit Bluetooth charger"),
              data: { serialNumber, name: charger.name, pin: "" },
              buttons: ["apply", "cancel"],
            });
            if (!form) {
              return { refresh: "none" };
            }
            try {
              await this.adapter.editBluetoothCharger(serialNumber, form);
            } catch (error) {
              await context.showMessage(
                getBluetoothDeviceActionErrorMessage(error, "save"),
              );
              return { refresh: "none" };
            }
            await context.showMessage(
              deviceManagerText(
                "Charger saved. Restart the adapter to apply the change.",
              ),
            );
            return { refresh: "instance" };
          },
        },
        {
          id: "removeBluetoothCharger",
          icon: "delete",
          title: deviceManagerText("Remove"),
          confirmation: deviceManagerText("Remove this Bluetooth charger?"),
          handler: async (deviceId, context) => {
            if (deviceId !== serialNumber) {
              return { refresh: "none" };
            }
            try {
              await this.adapter.removeBluetoothCharger(serialNumber);
            } catch (error) {
              await context.showMessage(
                getBluetoothDeviceActionErrorMessage(error, "remove"),
              );
              return { refresh: "none" };
            }
            await context.showMessage(
              deviceManagerText(
                "Charger removed. Restart the adapter to apply the change.",
              ),
            );
            return { refresh: "instance" };
          },
        },
      ],
    };
  }
}
