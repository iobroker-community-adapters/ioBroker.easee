/**
 * The answer of the message "help": what the instance answers, written for AI agents (e.g. ioBroker.pi-agent or
 * the MCP server with send_to) and script authors. Keep it in sync with onMessage in main.ts and the device
 * manager (@iobroker/dm-utils).
 */

/**
 * Every command the instance answers; write = the command changes something; standard = the command of the shared
 * catalog of sendTo commands (family.command) it follows
 */
export const COMMANDS: {
  command: string;
  write: boolean;
  standard?: string;
}[] = [
  { command: "help", write: false },
  { command: "getVehicles", write: false, standard: "vehicle.getVehicles" },
  { command: "charge", write: true, standard: "vehicle.charge" },
  {
    command: "setChargeCurrent",
    write: true,
    standard: "vehicle.setChargeCurrent",
  },
  { command: "bluetoothScan", write: true },
  { command: "dm:instanceInfo", write: false },
  { command: "dm:loadDevices", write: false },
  { command: "dm:deviceInfo", write: false },
  { command: "dm:deviceStatus", write: false },
  { command: "dm:deviceDetails", write: false },
  { command: "dm:instanceAction", write: true },
  { command: "dm:deviceAction", write: true },
  { command: "dm:deviceControl", write: true },
  { command: "dm:deviceControlState", write: false },
  { command: "dm:deviceLoadProgress", write: false },
  { command: "dm:actionProgress", write: true },
];

export const HELP = `ioBroker.easee: connects Easee wallboxes (chargers) through the Easee Cloud or locally by Bluetooth (setting
"connection mode"). Every charger is the device easee.0.<chargerId> (its serial number, e.g. EH123456) with the
channels status, config and control. An agent reads the charger through these states and controls charging with
the standard commands below (they follow the shared catalog of the vehicle family, where a wallbox counts as a
vehicle, and answer whether it worked) or by writing the states (ack false, no answer).

Commands (sendTo easee.0), standard commands of the shared catalog (vehicle = serial number or name of the charger,
compared without case; default the only charger; errors {error, reason: NOT_FOUND | AMBIGUOUS (with candidates) |
BAD_REQUEST | NOT_CONNECTED | BUSY (a Bluetooth search runs) | COMMAND_FAILED}; a write answers {ok: true} when the
Cloud or the charger confirmed it, or {ok: true, pending: true} after 14 s while it goes on):
- getVehicles {}: {vehicles: [{id: serial number, name, kind: "wallbox"}]}.
- charge {vehicle?, on: true | false}: on resumes a paused charger (status.chargerOpMode 4; by Bluetooth always
  resume, see control.resume) or starts charging (control.start, Cloud); off pauses (control.pause, can be resumed).
- setChargeCurrent {vehicle?, amps}: sets config.dynamicChargerCurrent (A, the current limit now; 0 = no charging;
  by Bluetooth whole amperes).
Commands for the settings:
- bluetoothScan {}: starts the manual Bluetooth search of the settings: {result: "completed"} or {error:
  "unavailable", "notReady", "busy" or "failed"}; for the settings, not for agents.
- dm:instanceInfo, dm:loadDevices, dm:deviceInfo, dm:deviceStatus, dm:deviceDetails, dm:instanceAction,
  dm:deviceAction, dm:deviceControl, dm:deviceControlState, dm:deviceLoadProgress, dm:actionProgress: the device
  manager of the admin, not for agents.

States (easee.0.<chargerId>.*):
- control.start, control.stop, control.pause, control.resume, control.reboot: write true to start, stop, pause or
  resume charging, or to restart the charger. start and stop work only with the Cloud. By Bluetooth pause sets the
  current limit to 0 and resume restores it (only after a pause by the same connection).
- status.chargerOpMode: 0 offline, 1 no car connected, 2 waiting to start, 3 charging, 4 paused or completed,
  5 error, 6 ready to charge, 7 waiting for authentication, 8 ending authentication. status.totalPower (kW),
  status.lifetimeEnergy (kWh), status.energyPerHour (kWh), status.voltage (V), status.outputCurrent,
  status.reasonForNoCurrent, status.cableLocked, status.isOnline (Cloud), status.authTokenName (who charged last).
- config.dynamicChargerCurrent (A): the current limit now, i.e. the charging speed (0 = no charging);
  config.maxChargerCurrent (A): the upper limit; config.isEnabled (false disables the charger); config.phaseMode
  (1 = 1 phase, 2 = auto, 3 = 3 phases); config.ledStripBrightness (0-100 %); config.lockCablePermanently;
  config.smartCharging and config.smartButtonEnabled (Cloud); config.dynamicCircuitCurrentP1 to P3 and
  config.circuitMaxCurrentP1 to P3 (A, the circuit of the site; in the Cloud write all three phases together);
  config.costPerKwhExcludeVat and config.vat (the price, Cloud). name: write a new name to rename the charger (Cloud).
A control.* write is confirmed with ack true when it was carried out; a failure is logged (the state stays ack
false), by Bluetooth also written to info.bluetoothError.

How to talk to the user:
- Name the charger by its name (easee.0.<chargerId>.name), not by its serial number; if there are several, ask which.
- Before starting say what the charger reports (status.chargerOpMode): a car must be connected.
- charge, setChargeCurrent, control.* and config.* change the charger: only on the user's request; control.reboot,
  config.isEnabled false, config.lockCablePermanently and the circuit currents only on the user's explicit request.
- Name currents in A and power in kW; times in local time.`;
