"use strict";

const utils = require("@iobroker/adapter-core");

const axios = require("axios").default;
const signalR = require("@microsoft/signalr");
const objEnum = require("./lib/enum.js");
const AxiosSignalRHttpClient = require("./lib/signalr-http-client.js");
const {
  CHARGER_STATE_OBSERVATION_IDS,
  observationsToChargerState,
} = require("./lib/observations.js");

//Eigene Variablen
const apiUrl = "https://api.easee.com";
const apiRequestTimeout = 30000;
const sessionRequestInterval = 7 * 60 * 1000;
const defaultSessionPollInterval = 60;
const adapterIntervals = {}; //halten von allen Intervallen
let accessToken = "";
let refreshToken = "";
let expireTime = Date.now();
let polltime = 30;
let logtype = false;
const tokenRefreshMarginSeconds = 60;
const arrCharger = [];

function getRateLimitDelay(error) {
  const headers = error?.response?.headers;
  const header = (name) =>
    headers?.get?.(name) ?? headers?.[name] ?? headers?.[name.toLowerCase()];
  const retryAfter = header("retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.max(0, retryAt - Date.now());
    }
  }

  const remaining = Number(
    header("ratelimit-remaining") ?? header("x-ratelimit-remaining"),
  );
  if (remaining === 0) {
    const reset = Number(header("ratelimit-reset"));
    if (Number.isFinite(reset)) {
      return Math.max(0, reset * 1000);
    }
    const legacyReset = Number(header("x-ratelimit-reset"));
    if (Number.isFinite(legacyReset)) {
      const resetAt = legacyReset > 1e12 ? legacyReset : legacyReset * 1000;
      return Math.max(0, resetAt - Date.now());
    }
  }

  return error?.response?.status === 429 ? sessionRequestInterval : 0;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class Easee extends utils.Adapter {
  constructor(options) {
    super({
      ...options,
      name: "easee",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.signalRConnection = null;
    this.signalRSubscribedChargers = new Set();
    this.signalRSubscriptionPromises = new Map();
    this.signalRSubscriptionPromises = new Map();
    this.unloading = false;
    this.apiRetryState = new Map();
    this.pendingSiteConfigRetries = new Map();
    this.dynamicCircuitCurrentByCharger = new Map();
    this.dynamicCircuitCurrentByCircuit = new Map();
    this.dynamicCircuitCurrentSequence = 0;
    this.circuitMaxCurrentByCircuit = new Map();
    this.circuitMaxCurrentSequence = 0;
    this.sessionChargers = [];
    this.sessionCursor = 0;
    this.sessionPollTimer = null;
    this.sessionInFlight = null;
    this.sessionAbortController = null;
    this.sessionLastRequestAt = null;
    this.sessionRetryAt = 0;
    this.sessionPollMode = "auto";
    this.sessionManualInterval = defaultSessionPollInterval;
  }
  /**
   * SignalR
   */
  async startSignal() {
    if (this.unloading || this.signalRConnection !== null) {
      return;
    }
    const connection = new signalR.HubConnectionBuilder()
      .withUrl("https://streams.easee.com/hubs/chargers", {
        accessTokenFactory: () => accessToken,
        httpClient: new AxiosSignalRHttpClient(),
        skipNegotiation: true,
        transport: signalR.HttpTransportType.WebSockets,
      })
      .withAutomaticReconnect()
      .build();
    this.signalRConnection = connection;

    connection.on("ProductUpdate", (data) => {
      //haben einen neuen Wert über SignalR erhalten
      const data_name = objEnum.getNameByEnum(data.id);
      if (data_name == undefined) {
        this.log.debug(`New SignalR-ID, possible new Value: ${data.id}`);
        this.log.debug(JSON.stringify(data));
      } else {
        //Value is in ioBroker, update it
        const tmpValueId = data.mid + data_name;
        this.log.debug(
          `New value over SignalR for: ${tmpValueId}, value: ${data.value}`,
        );
        switch (data.dataType) {
          case 2:
            data.value = data.value == "1";
            break;
          case 3:
            data.value = parseFloat(data.value);
            break;
          case 4:
            data.value = parseInt(data.value);
            break;
          //case 6: JSON
        }
        this.setStateAsync(tmpValueId, { val: data.value, ack: true }).catch(
          (error) =>
            this.log.warn(
              `SignalR state update failed: ${errorMessage(error)}`,
            ),
        );
      }
    });

    connection.onclose((error) => {
      if (this.signalRConnection === connection) {
        this.signalRConnection = null;
      }
      if (!this.unloading) {
        this.log.warn(
          `SignalR connection closed: ${errorMessage(error || "unknown reason")}`,
        );
        this.scheduleSignalRReconnect();
      }
    });

    try {
      await connection.start();
      this.signalRSubscribedChargers.clear();
      for (const charger_id of arrCharger) {
        await this.subscribeChargerToSignalR(charger_id);
      }
    } catch (error) {
      if (this.signalRConnection === connection) {
        this.signalRConnection = null;
      }
      this.log.warn(
        `SignalR start failed; REST polling remains active: ${errorMessage(error)}`,
      );
      this.scheduleSignalRReconnect();
    }
  }

  async subscribeChargerToSignalR(chargerId) {
    const connection = this.signalRConnection;
    if (
      this.unloading ||
      !connection ||
      connection.state !== signalR.HubConnectionState.Connected ||
      this.signalRSubscribedChargers.has(chargerId)
    ) {
      return;
    }
    const existingSubscription =
      this.signalRSubscriptionPromises.get(chargerId);
    if (existingSubscription) {
      return existingSubscription;
    }

    const subscription = connection
      .send("SubscribeWithCurrentState", chargerId, true)
      .then(() => {
        if (this.signalRConnection === connection && !this.unloading) {
          this.signalRSubscribedChargers.add(chargerId);
          this.log.info(`Charger registered in SignalR: ${chargerId}`);
        }
      })
      .catch((error) => {
        this.log.warn(
          `SignalR subscription failed for charger ${chargerId}: ${errorMessage(error)}`,
        );
      })
      .finally(() => {
        if (this.signalRSubscriptionPromises.get(chargerId) === subscription) {
          this.signalRSubscriptionPromises.delete(chargerId);
        }
      });
    this.signalRSubscriptionPromises.set(chargerId, subscription);
    return subscription;
  }

  scheduleSignalRReconnect() {
    if (this.unloading) {
      return;
    }
    clearTimeout(adapterIntervals.signalRReconnect);
    adapterIntervals.signalRReconnect = setTimeout(() => {
      this.startSignal();
    }, 30000);
  }

  /**
   * Starten den Adapter
   */
  async onReady() {
    //initial Status melden
    await this.setStateAsync("info.connection", false, true);

    this.configureSessionPolling();
    await this.setObjectNotExistsAsync("info.sessionPollLastRequest", {
      type: "state",
      common: {
        name: "Last session request",
        type: "number",
        role: "value.time",
        unit: "ms",
        read: true,
        write: false,
      },
      native: {},
    });
    const lastSessionRequest = await this.getStateAsync(
      "info.sessionPollLastRequest",
    );
    if (Number.isFinite(lastSessionRequest?.val)) {
      this.sessionLastRequestAt = lastSessionRequest.val;
    }

    //Schauen ob die Polltime realistisch ist
    if (this.config.polltime < 1) {
      this.log.error("Interval in seconds to short -> go to default 30");
    } else {
      polltime = this.config.polltime;
    }
    logtype = this.config.logtype;
    // Testen ob der Login funktioniert
    if (this.config.username == "" || this.config.username == "+49") {
      this.log.error("No username set");
    } else if (this.config.client_secret == "") {
      this.log.error("No password set");
    } else {
      this.log.debug("Api login started");
      const login = await this.login(
        this.config.username,
        this.config.client_secret,
      );
      if (login) {
        //Erstes Objekt erstellen
        await this.setObjectNotExistsAsync("lastUpdate", {
          type: "state",
          common: {
            name: "lastUpdate",
            type: "string",
            role: "indicator",
            read: true,
            write: false,
          },
          native: {},
        });

        //reset all to start
        arrCharger.length = 0;

        if (this.config.signalR) {
          this.log.info("Starting SignalR");
          this.startSignal();
        }
        // Start polling without delaying SignalR on a slow API response.
        await this.readAllStates();
      }
    }
  }

  configureSessionPolling() {
    this.sessionPollMode =
      this.config.sessionPollMode === "manual" ? "manual" : "auto";
    const configuredInterval = Number(this.config.sessionPollInterval);
    this.sessionManualInterval = Number.isFinite(configuredInterval)
      ? Math.max(7, configuredInterval)
      : defaultSessionPollInterval;
    if (
      this.sessionPollMode === "manual" &&
      this.sessionManualInterval !== configuredInterval
    ) {
      this.log.warn(
        "Manual session interval must be at least 7 minutes; using 7 minutes",
      );
    }
  }

  // Clear all Timeouts and inform users
  onUnload(callback) {
    this.unloading = true;
    clearTimeout(adapterIntervals.readAllStates);
    clearTimeout(this.sessionPollTimer);
    this.sessionPollTimer = null;
    this.sessionAbortController?.abort();
    const sessionShutdown = this.sessionInFlight;
    for (const chargerState of this.dynamicCircuitCurrentByCharger.values()) {
      clearTimeout(chargerState.timer);
      clearTimeout(chargerState.retryTimer);
      chargerState.retryResolve?.();
    }
    this.dynamicCircuitCurrentByCharger.clear();
    for (const circuitState of this.dynamicCircuitCurrentByCircuit.values()) {
      clearTimeout(circuitState.timer);
    }
    this.dynamicCircuitCurrentByCircuit.clear();
    clearTimeout(adapterIntervals.signalRReconnect);
    for (const retry of this.pendingSiteConfigRetries.values()) {
      clearTimeout(retry.timer);
    }
    this.pendingSiteConfigRetries.clear();
    const signalRShutdown = Promise.resolve(
      this.signalRConnection?.stop(),
    ).catch((error) =>
      this.log.warn(`Error stopping SignalR: ${errorMessage(error)}`),
    );
    const pendingSessionShutdown = Promise.resolve(sessionShutdown).catch(
      (error) =>
        this.log.warn(`Error stopping session polling: ${errorMessage(error)}`),
    );
    Promise.all([signalRShutdown, pendingSessionShutdown])
      .then(() => this.setStateAsync("info.connection", false, true))
      .catch((error) =>
        this.log.error(`Error during unload: ${errorMessage(error)}`),
      )
      .finally(() => {
        this.signalRConnection = null;
        this.log.info("Adapter easee cleaned up everything...");
        callback();
      });
  }

  async requestWithBackoff(key, requestFn) {
    let retryState = this.apiRetryState.get(key);
    if (!retryState) {
      retryState = { delay: 30000, retryAt: 0, inFlight: null };
      this.apiRetryState.set(key, retryState);
    }
    if (retryState.inFlight) {
      return retryState.inFlight;
    }
    if (retryState.retryAt > Date.now()) {
      const error = new Error(`Retry deferred for ${key}`);
      error.retryDeferred = true;
      throw error;
    }

    retryState.inFlight = (async () => {
      try {
        const response = await requestFn();
        this.apiRetryState.delete(key);
        return response;
      } catch (error) {
        if (this.unloading) {
          throw error;
        }
        const delay = Math.max(retryState.delay, getRateLimitDelay(error));
        retryState.retryAt = Date.now() + delay;
        if (key.startsWith("charger session ")) {
          this.sessionRetryAt = Math.max(
            this.sessionRetryAt,
            retryState.retryAt,
          );
        }
        retryState.delay = Math.min(Math.max(delay * 2, 30000), 300000);
        this.log.warn(
          `Easee API request failed for ${key}; retrying after ${Math.ceil(delay / 1000)} seconds: ${errorMessage(error)}`,
        );
        const retryError = new Error(errorMessage(error));
        retryError.retryDeferred = true;
        throw retryError;
      } finally {
        retryState.inFlight = null;
      }
    })();
    return retryState.inFlight;
  }

  async updateSiteConfigWithRetry(
    chargerId,
    stateId,
    description,
    update,
    sequence,
  ) {
    if (this.unloading) {
      return;
    }

    try {
      const site = await this.getChargerSite(chargerId);
      if (!site?.circuits?.[0]) {
        this.log.warn(`Unable to update ${description}: site data missing`);
        return;
      }
      const circuitKey = `${site.id}:${site.circuits[0].id}`;
      const latestSequence =
        this.circuitMaxCurrentByCircuit.get(circuitKey) || 0;
      if (sequence < latestSequence) {
        this.log.info(`Discarded superseded ${description} for ${circuitKey}`);
        return;
      }
      this.circuitMaxCurrentByCircuit.set(circuitKey, sequence);
      await update(site);
    } catch (error) {
      if (!error?.retryDeferred || this.unloading) {
        this.log.error(`${description} error: ${errorMessage(error)}`);
        return;
      }

      const retryKey = `${chargerId}:${stateId}`;
      const existingRetry = this.pendingSiteConfigRetries.get(retryKey);
      if (existingRetry) {
        clearTimeout(existingRetry.timer);
      }

      const siteRetry = this.apiRetryState.get(`charger site ${chargerId}`);
      const delay = Math.max(
        0,
        (siteRetry?.retryAt || Date.now()) - Date.now(),
      );
      const timer = setTimeout(() => {
        this.pendingSiteConfigRetries.delete(retryKey);
        this.updateSiteConfigWithRetry(
          chargerId,
          stateId,
          description,
          update,
          sequence,
        );
      }, delay);
      this.pendingSiteConfigRetries.set(retryKey, { timer });
      this.log.info(
        `${description} queued for retry in ${Math.ceil(delay / 1000)} seconds`,
      );
    }
  }

  async updateDynamicCircuitWithRetry(
    chargerId,
    chargerState,
    changedValues,
    phaseSequences,
  ) {
    while (!this.unloading) {
      if (
        Object.entries(phaseSequences).some(
          ([phase, sequence]) =>
            chargerState.latestSequences[phase] !== sequence,
        )
      ) {
        this.log.info(
          `Discarded superseded Dynamic circuit current update for ${chargerId}`,
        );
        return;
      }
      try {
        const site = await this.getChargerSite(chargerId);
        if (!site?.circuits?.[0]) {
          this.log.warn(
            "Unable to update Dynamic circuit current: site data missing",
          );
          return;
        }

        if (
          Object.entries(phaseSequences).some(
            ([phase, sequence]) =>
              chargerState.latestSequences[phase] !== sequence,
          )
        ) {
          this.log.info(
            `Discarded superseded Dynamic circuit current update for ${chargerId}`,
          );
          return;
        }

        const circuitId = site.circuits[0].id;
        const circuitKey = `${site.id}:${circuitId}`;
        let circuitState = this.dynamicCircuitCurrentByCircuit.get(circuitKey);
        if (!circuitState) {
          circuitState = {
            values: { p1: 0, p2: 0, p3: 0 },
            phaseSequences: { p1: 0, p2: 0, p3: 0 },
            timer: null,
            queue: Promise.resolve(),
          };
          this.dynamicCircuitCurrentByCircuit.set(circuitKey, circuitState);
        }
        let updated = false;
        for (const [phase, value] of Object.entries(changedValues)) {
          const sequence = phaseSequences[phase];
          if (sequence >= circuitState.phaseSequences[phase]) {
            circuitState.values[phase] = value;
            circuitState.phaseSequences[phase] = sequence;
            updated = true;
          }
        }
        if (!updated) {
          this.log.info(
            `Discarded superseded Dynamic circuit current update for ${circuitKey}`,
          );
          return;
        }
        if (circuitState.timer === null) {
          circuitState.timer = setTimeout(() => {
            circuitState.timer = null;
            const currentValues = { ...circuitState.values };
            circuitState.values = { p1: 0, p2: 0, p3: 0 };
            circuitState.queue = circuitState.queue
              .catch((error) => {
                this.log.error(
                  `Previous circuit current update failed: ${errorMessage(error)}`,
                );
              })
              .then(() => {
                if (this.unloading) {
                  return;
                }
                return this.changeCircuitConfig(
                  site.id,
                  circuitId,
                  currentValues,
                );
              });
          }, 500);
        }
        return;
      } catch (error) {
        if (!error?.retryDeferred || this.unloading) {
          this.log.error(
            `Dynamic circuit current update error: ${errorMessage(error)}`,
          );
          return;
        }

        const siteRetry = this.apiRetryState.get(`charger site ${chargerId}`);
        const delay = Math.max(
          0,
          (siteRetry?.retryAt || Date.now()) - Date.now(),
        );
        await new Promise((resolve) => {
          chargerState.retryResolve = resolve;
          chargerState.retryTimer = setTimeout(resolve, delay);
        });
        chargerState.retryResolve = null;
        chargerState.retryTimer = null;
      }
    }
  }

  /*****************************************************************************************/
  async readAllStates() {
    if (this.unloading) {
      return;
    }

    if (expireTime <= Date.now()) {
      //Token ist expired!
      if (logtype) {
        this.log.info("Token has expired - refresh");
      }
      await this.refreshToken();
    }
    if (this.unloading) {
      return;
    }
    this.log.debug("read new states from the API");

    //Lesen alle Charger aus
    const tmpAllChargers = await this.getAllCharger();
    if (this.unloading) {
      return;
    }
    if (tmpAllChargers != undefined) {
      this.updateSessionChargers(tmpAllChargers);
      for (const charger of tmpAllChargers) {
        if (this.unloading) {
          return;
        }
        //Prüfen ob wir das Object kennen
        if (!arrCharger.includes(charger.id)) {
          //setzen als erstes alle Objekte
          await this.setAllStatusObjects(charger);
          await this.setAllConfigObjects(charger);

          //merken uns den charger
          arrCharger.push(charger.id);
        }
        await this.subscribeChargerToSignalR(charger.id);
        if (this.unloading) {
          return;
        }

        this.log.debug("Charger found");
        this.log.debug(JSON.stringify(charger));
        try {
          //Lesen den Status aus
          const tmpChargerState = await this.getChargerState(charger.id);
          if (this.unloading) {
            return;
          }
          //Lesen die config
          const tmpChargerConfig = await this.getChargerConfig(charger.id);
          if (this.unloading) {
            return;
          }

          //Setzen die Daten der Charger
          await this.setNewStatusToCharger(charger, tmpChargerState);

          //Setzen die Config zum Charger
          await this.setConfigStatus(charger, tmpChargerConfig);
        } catch (error) {
          if (error?.retryDeferred) {
            continue;
          }
          if (typeof error === "string") {
            this.log.error(error);
          } else if (error instanceof Error) {
            this.log.error(error.message);
          }
        }
      }
    } else {
      this.log.warn("No Chargers found!");
    }

    if (this.unloading) {
      return;
    }

    //Melden das Update
    await this.setStateAsync(
      "lastUpdate",
      new Date().toLocaleTimeString(),
      true,
    );
    if (!this.unloading) {
      adapterIntervals.readAllStates = setTimeout(
        this.readAllStates.bind(this),
        polltime * 1000,
      );
    }
  }

  updateSessionChargers(chargers) {
    const nextCharger = this.sessionChargers[this.sessionCursor];
    const previousChargers = this.sessionChargers;
    this.sessionChargers = [
      ...new Set((chargers || []).map((charger) => charger.id)),
    ];
    const changed =
      previousChargers.length !== this.sessionChargers.length ||
      previousChargers.some(
        (chargerId, index) => chargerId !== this.sessionChargers[index],
      );
    this.sessionCursor = nextCharger
      ? Math.max(this.sessionChargers.indexOf(nextCharger), 0)
      : this.sessionCursor % Math.max(this.sessionChargers.length, 1);

    this.updateSessionPollInfo().catch((error) => {
      this.log.warn(
        `Could not update session polling information: ${errorMessage(error)}`,
      );
    });

    if (!this.sessionChargers.length) {
      clearTimeout(this.sessionPollTimer);
      this.sessionPollTimer = null;
      return;
    }
    if (!this.sessionInFlight && (this.sessionPollTimer === null || changed)) {
      const nextSlotDelay =
        this.sessionLastRequestAt === null
          ? 0
          : Math.max(
              0,
              this.sessionLastRequestAt +
                this.getSessionRequestInterval() -
                Date.now(),
            );
      this.scheduleSessionPoll(nextSlotDelay);
    }
  }

  async updateSessionPollInfo() {
    const chargerCount = this.sessionChargers.length;
    if (!chargerCount) {
      return;
    }
    const recommendedInterval = chargerCount * 7;
    const effectiveInterval =
      this.sessionPollMode === "manual"
        ? Math.max(recommendedInterval, this.sessionManualInterval)
        : recommendedInterval;
    await Promise.all([
      this.setStateAsync("info.sessionPollChargerCount", chargerCount, true),
      this.setStateAsync(
        "info.sessionPollRecommendedInterval",
        recommendedInterval,
        true,
      ),
      this.setStateAsync(
        "info.sessionPollEffectiveInterval",
        effectiveInterval,
        true,
      ),
    ]);
  }

  getSessionRequestInterval() {
    const chargerCount = this.sessionChargers.length;
    if (!chargerCount) {
      return sessionRequestInterval;
    }
    const effectiveInterval =
      this.sessionPollMode === "manual"
        ? Math.max(chargerCount * 7, this.sessionManualInterval)
        : chargerCount * 7;
    return Math.max(
      sessionRequestInterval,
      (effectiveInterval * 60000) / chargerCount,
    );
  }

  scheduleSessionPoll(delay) {
    if (
      this.unloading ||
      !this.sessionChargers.length ||
      this.sessionInFlight
    ) {
      return;
    }
    clearTimeout(this.sessionPollTimer);
    this.sessionPollTimer = setTimeout(() => {
      this.sessionPollTimer = null;
      this.pollNextSession().catch((error) => {
        this.log.warn(`Session polling failed: ${errorMessage(error)}`);
      });
    }, delay);
  }

  async pollNextSession() {
    if (
      this.unloading ||
      this.sessionInFlight ||
      !this.sessionChargers.length
    ) {
      return;
    }

    const minRequestDelay =
      this.sessionLastRequestAt === null
        ? 0
        : Math.max(
            0,
            this.sessionLastRequestAt +
              this.getSessionRequestInterval() -
              Date.now(),
          );
    if (minRequestDelay > 0) {
      this.scheduleSessionPoll(minRequestDelay);
      return;
    }

    const sharedRetryDelay = this.sessionRetryAt - Date.now();
    if (sharedRetryDelay > 0) {
      this.scheduleSessionPoll(Math.max(minRequestDelay, sharedRetryDelay));
      return;
    }

    let selectedIndex = -1;
    let earliestRetryAt = Infinity;
    for (let offset = 0; offset < this.sessionChargers.length; offset++) {
      const index = (this.sessionCursor + offset) % this.sessionChargers.length;
      const chargerId = this.sessionChargers[index];
      const retryAt =
        this.apiRetryState.get(`charger session ${chargerId}`)?.retryAt || 0;
      if (retryAt <= Date.now()) {
        selectedIndex = index;
        break;
      }
      earliestRetryAt = Math.min(earliestRetryAt, retryAt);
    }

    if (selectedIndex < 0) {
      this.scheduleSessionPoll(
        Math.max(minRequestDelay, earliestRetryAt - Date.now()),
      );
      return;
    }

    const chargerId = this.sessionChargers[selectedIndex];
    this.sessionCursor = (selectedIndex + 1) % this.sessionChargers.length;
    this.sessionLastRequestAt = Date.now();
    this.setStateAsync(
      "info.sessionPollLastRequest",
      this.sessionLastRequestAt,
      true,
    ).catch((error) => {
      this.log.warn(
        `Could not persist session request time: ${errorMessage(error)}`,
      );
    });
    const controller = new AbortController();
    this.sessionAbortController = controller;
    const request = (async () => {
      try {
        const sessions = await this.getChargerSession(
          chargerId,
          controller.signal,
        );
        if (!this.unloading && this.sessionChargers.includes(chargerId)) {
          await this.setNewSessionToCharger({ id: chargerId }, sessions);
        }
      } catch (error) {
        if (!this.unloading) {
          this.log.warn(
            `Session request failed for charger ${chargerId}: ${errorMessage(error)}`,
          );
        }
      } finally {
        this.sessionInFlight = null;
        this.sessionAbortController = null;
        const delay = Math.max(
          0,
          this.sessionLastRequestAt +
            this.getSessionRequestInterval() -
            Date.now(),
        );
        this.scheduleSessionPoll(delay);
      }
    })();
    this.sessionInFlight = request;
    await request;
  }

  //Is called if a subscribed state changes
  onStateChange(id, state) {
    if (state) {
      // The state was changed
      this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
      const tmpControl = id.split(".");
      if (tmpControl[3] == "config") {
        // change config, wenn ack = false
        if (!state.ack) {
          if (
            tmpControl[4] == "circuitMaxCurrentP1" ||
            tmpControl[4] == "circuitMaxCurrentP2" ||
            tmpControl[4] == "circuitMaxCurrentP3"
          ) {
            //Load site for Charger
            this.updateSiteConfigWithRetry(
              tmpControl[2],
              id,
              "Circuit current update",
              async (site) => {
                this.log.debug(`Update circuitMaxCurrent to: ${state.val}`);
                this.log.debug("Get infos from site:");
                this.log.debug(JSON.stringify(site));

                await this.changeMaxCircuitConfig(
                  site.id,
                  site.circuits[0].id,
                  state.val,
                );
                this.log.debug("Changes sent to API");
              },
              ++this.circuitMaxCurrentSequence,
            );
          } else if (
            tmpControl[4] == "dynamicCircuitCurrentP1" ||
            tmpControl[4] == "dynamicCircuitCurrentP2" ||
            tmpControl[4] == "dynamicCircuitCurrentP3"
          ) {
            const chargerId = tmpControl[2];
            let currentState =
              this.dynamicCircuitCurrentByCharger.get(chargerId);
            if (!currentState) {
              currentState = {
                pendingValues: {},
                pendingSequences: {},
                latestSequences: { p1: 0, p2: 0, p3: 0 },
                timer: null,
                retryTimer: null,
                retryResolve: null,
                queue: Promise.resolve(),
              };
              this.dynamicCircuitCurrentByCharger.set(chargerId, currentState);
            }
            let phase;
            switch (tmpControl[4]) {
              case "dynamicCircuitCurrentP1":
                phase = "p1";
                break;
              case "dynamicCircuitCurrentP2":
                phase = "p2";
                break;
              case "dynamicCircuitCurrentP3":
                phase = "p3";
                break;
            }
            currentState.pendingValues[phase] = Number(state.val);
            currentState.pendingSequences[phase] = ++this
              .dynamicCircuitCurrentSequence;
            currentState.latestSequences[phase] =
              currentState.pendingSequences[phase];
            clearTimeout(currentState.timer);
            currentState.timer = setTimeout(() => {
              currentState.timer = null;
              const changedValues = { ...currentState.pendingValues };
              const phaseSequences = { ...currentState.pendingSequences };
              currentState.pendingValues = {};
              currentState.pendingSequences = {};
              currentState.queue = currentState.queue
                .catch((error) => {
                  this.log.error(
                    `Previous dynamic current update failed: ${errorMessage(error)}`,
                  );
                })
                .then(() => {
                  if (this.unloading) {
                    return;
                  }
                  return this.updateDynamicCircuitWithRetry(
                    chargerId,
                    currentState,
                    changedValues,
                    phaseSequences,
                  );
                });
            }, 500);
          } else {
            this.log.debug(`update config to API: ${id}`);
            if (tmpControl[4] == "isEnabled") {
              this.changeConfig(tmpControl[2], "enabled", state.val);
            } else {
              this.changeConfig(tmpControl[2], tmpControl[4], state.val);
            }
            this.log.debug("Changes sent to API");
          }
        }
      } else {
        // control charger
        switch (tmpControl[4]) {
          case "start":
            // Starten Ladevorgang
            this.log.info(`Starting charging for Charger.id: ${tmpControl[2]}`);
            this.startCharging(tmpControl[2]);
            break;
          case "stop":
            //  Stopen Ladevorgang
            this.log.info(`Stopping charging for Charger.id: ${tmpControl[2]}`);
            this.stopCharging(tmpControl[2]);
            break;
          case "pause":
            //  Pausiere Ladevorgang
            this.log.info(`Pause charging for Charger.id: ${tmpControl[2]}`);
            this.pauseCharging(tmpControl[2]);
            break;
          case "resume":
            //  Resume Ladevorgang
            this.log.info(`Resume charging for Charger.id: ${tmpControl[2]}`);
            this.resumeCharging(tmpControl[2]);
            break;
          case "reboot":
            //  Reboot Charger
            this.log.info(`Reboot Charger.id: ${tmpControl[2]}`);
            this.rebootCharging(tmpControl[2]);
            break;
          default:
            this.log.error(`No command for Control found for: ${id}`);
        }
      }
    } else {
      // The state was deleted
      this.log.info(`state ${id} deleted`);
    }
  }

  /***********************************************************************
   * Funktionen für Status der Reading um den Code aufgeräumter zu machen
   ***********************************************************************/

  //Setzen alle Status für Charger
  async setNewStatusToCharger(charger, charger_states) {
    await this.setStateAsync(`${charger.id}.name`, charger.name, true);
    await this.setStateAsync(
      `${charger.id}.status.cableLocked`,
      charger_states.cableLocked,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.chargerOpMode`,
      charger_states.chargerOpMode,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.totalPower`,
      charger_states.totalPower,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.wiFiRSSI`,
      charger_states.wiFiRSSI,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.chargerFirmware`,
      charger_states.chargerFirmware,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.reasonForNoCurrent`,
      charger_states.reasonForNoCurrent,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.voltage`,
      charger_states.voltage,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.outputCurrent`,
      charger_states.outputCurrent,
      true,
    );
    if (typeof charger_states.isOnline === "boolean") {
      await this.setStateAsync(
        `${charger.id}.status.isOnline`,
        charger_states.isOnline,
        true,
      );
    }
    await this.setStateAsync(
      `${charger.id}.status.wiFiAPEnabled`,
      charger_states.wiFiAPEnabled,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.ledMode`,
      charger_states.ledMode,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.lifetimeEnergy`,
      charger_states.lifetimeEnergy,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.energyPerHour`,
      charger_states.energyPerHour,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.inCurrentT2`,
      charger_states.inCurrentT2,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.inCurrentT3`,
      charger_states.inCurrentT3,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.inCurrentT4`,
      charger_states.inCurrentT4,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.inCurrentT5`,
      charger_states.inCurrentT5,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.inVoltageT1T2`,
      charger_states.inVoltageT1T2,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.inVoltageT1T3`,
      charger_states.inVoltageT1T3,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.inVoltageT1T4`,
      charger_states.inVoltageT1T4,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.inVoltageT1T5`,
      charger_states.inVoltageT1T5,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.inVoltageT2T3`,
      charger_states.inVoltageT2T3,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.inVoltageT2T4`,
      charger_states.inVoltageT2T4,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.inVoltageT2T5`,
      charger_states.inVoltageT2T5,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.inVoltageT3T4`,
      charger_states.inVoltageT3T4,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.inVoltageT3T5`,
      charger_states.inVoltageT3T5,
      true,
    );
    await this.setStateAsync(
      `${charger.id}.status.inVoltageT4T5`,
      charger_states.inVoltageT4T5,
      true,
    );

    //wert der config wird nur hier gesendet
    await this.setStateAsync(`${charger.id}.config.dynamicChargerCurrent`, {
      val: charger_states.dynamicChargerCurrent,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.dynamicCircuitCurrentP1`, {
      val: charger_states.dynamicCircuitCurrentP1,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.dynamicCircuitCurrentP2`, {
      val: charger_states.dynamicCircuitCurrentP2,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.dynamicCircuitCurrentP3`, {
      val: charger_states.dynamicCircuitCurrentP3,
      ack: true,
    });
    await this.setStateAsync(
      `${charger.id}.config.smartCharging`,
      charger_states.smartCharging,
      true,
    );
  }

  //Setzen alle Status für Config
  async setConfigStatus(charger, charger_config) {
    await this.setStateAsync(`${charger.id}.config.isEnabled`, {
      val: charger_config.isEnabled,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.phaseMode`, {
      val: charger_config.phaseMode,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.ledStripBrightness`, {
      val: charger_config.ledStripBrightness,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.smartButtonEnabled`, {
      val: charger_config.smartButtonEnabled,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.wiFiSSID`, {
      val: charger_config.wiFiSSID,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.maxChargerCurrent`, {
      val: charger_config.maxChargerCurrent,
      ack: true,
    });

    //Values for sites
    await this.setStateAsync(`${charger.id}.config.circuitMaxCurrentP1`, {
      val: charger_config.circuitMaxCurrentP1,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.circuitMaxCurrentP2`, {
      val: charger_config.circuitMaxCurrentP3,
      ack: true,
    });
    await this.setStateAsync(`${charger.id}.config.circuitMaxCurrentP3`, {
      val: charger_config.circuitMaxCurrentP3,
      ack: true,
    });
  }

  /*************************************************************************
   * API CALLS
   * //Todo auslagern in eigene Datei ?
   **************************************************************************/

  //Get Token from API
  async login(username, password) {
    try {
      const response = await axios.post(
        `${apiUrl}/api/accounts/login`,
        {
          userName: username,
          password: password,
        },
        { timeout: apiRequestTimeout },
      );

      this.log.info("Easee Api Login successful");

      accessToken = response.data.accessToken;
      refreshToken = response.data.refreshToken;
      expireTime =
        Date.now() +
        Math.max(
          Number(response.data.expiresIn) - tokenRefreshMarginSeconds,
          0,
        ) *
          1000;
      this.log.debug("Easee access token received");
      await this.setStateAsync("info.connection", true, true);
      return true;
    } catch (error) {
      this.log.error("Api login error - check Username and password");
      if (typeof error === "string") {
        this.log.error(error);
      } else if (error instanceof Error) {
        this.log.error(error.message);
      }
      await this.setStateAsync("info.connection", false, true);
      return false;
    }
  }

  //GET net Token from API
  async refreshToken() {
    return await axios
      .post(
        `${apiUrl}/api/accounts/refresh_token`,
        {
          accessToken: accessToken,
          refreshToken: refreshToken,
        },
        { timeout: apiRequestTimeout },
      )
      .then(async (response) => {
        if (logtype) {
          this.log.info("RefreshToken successful");
        }
        accessToken = response.data.accessToken;
        refreshToken = response.data.refreshToken;
        expireTime =
          Date.now() +
          Math.max(
            Number(response.data.expiresIn) - tokenRefreshMarginSeconds,
            0,
          ) *
            1000;
        await this.setStateAsync("info.connection", true, true);
        this.log.debug("Easee access token refreshed");
      })
      .catch(async (error) => {
        this.log.error("RefreshToken error");
        this.log.error(error);
        await this.setStateAsync("info.connection", false, true);
      });
  }

  //Lese alle Charger aus
  async getAllCharger() {
    return await axios
      .get(`${apiUrl}/api/chargers`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: apiRequestTimeout,
      })
      .then((response) => {
        this.log.debug("Chargers ausgelesen");
        this.log.debug(JSON.stringify(response.data));
        return response.data;
      })
      .catch((error) => {
        this.log.error(error);
      });
  }

  // Lese den Charger aus
  async getChargerState(charger_id) {
    const response = await this.requestWithBackoff(
      `charger observations ${charger_id}`,
      () =>
        axios.get(`${apiUrl}/state/${charger_id}/observations`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { ids: CHARGER_STATE_OBSERVATION_IDS.join(",") },
          timeout: apiRequestTimeout,
        }),
    );
    this.log.debug(`Charger observations read for id: ${charger_id}`);
    this.log.debug(JSON.stringify(response.data));
    return observationsToChargerState(response.data);
  }

  async getChargerConfig(charger_id) {
    const response = await this.requestWithBackoff(
      `charger config ${charger_id}`,
      () =>
        axios.get(`${apiUrl}/api/chargers/${charger_id}/config`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: apiRequestTimeout,
        }),
    );
    this.log.debug(`Charger config ausgelesen mit id: ${charger_id}`);
    this.log.debug(JSON.stringify(response.data));
    return response.data;
  }

  async getChargerSite(charger_id) {
    const response = await this.requestWithBackoff(
      `charger site ${charger_id}`,
      () =>
        axios.get(`${apiUrl}/api/chargers/${charger_id}/site`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: apiRequestTimeout,
        }),
    );
    this.log.debug(`Charger site ausgelesen mit id: ${charger_id}`);
    this.log.debug(JSON.stringify(response.data));
    return response.data;
  }

  async getChargerSession(charger_id, signal) {
    const response = await this.requestWithBackoff(
      `charger session ${charger_id}`,
      () =>
        axios.get(`${apiUrl}/api/sessions/charger/${charger_id}/monthly`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: apiRequestTimeout,
          signal,
        }),
    );
    this.log.debug(`Charger session ausgelesen mit id: ${charger_id}`);
    this.log.debug(JSON.stringify(response.data));
    return response.data;
  }

  async startCharging(id) {
    return await axios
      .post(
        `${apiUrl}/api/chargers/${id}/commands/start_charging`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      .then((response) => {
        this.log.info("Start charging successful");
        this.log.debug(JSON.stringify(response.data));
      })
      .catch((error) => {
        this.log.error("Start charging error");
        this.log.error(error);
      });
  }

  async stopCharging(id) {
    return await axios
      .post(
        `${apiUrl}/api/chargers/${id}/commands/stop_charging`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      .then((response) => {
        this.log.info("Stop charging successful");
        this.log.debug(JSON.stringify(response.data));
      })
      .catch((error) => {
        this.log.error("Stop charging error");
        this.log.error(error);
      });
  }

  async pauseCharging(id) {
    return await axios
      .post(
        `${apiUrl}/api/chargers/${id}/commands/pause_charging`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      .then((response) => {
        this.log.info("Pause charging successful");
        this.log.debug(JSON.stringify(response.data));
      })
      .catch((error) => {
        this.log.error("Pause charging error");
        this.log.error(error);
      });
  }

  async resumeCharging(id) {
    return await axios
      .post(
        `${apiUrl}/api/chargers/${id}/commands/resume_charging`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      .then((response) => {
        this.log.info("Resume charging successful");
        this.log.debug(JSON.stringify(response.data));
      })
      .catch((error) => {
        this.log.error("Resume charging error");
        this.log.error(error);
      });
  }

  async rebootCharging(id) {
    return await axios
      .post(
        `${apiUrl}/api/chargers/${id}/commands/reboot`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      .then((response) => {
        this.log.info("Reboot charging successful");
        this.log.debug(JSON.stringify(response.data));
      })
      .catch((error) => {
        this.log.error("Reboot charging error");
        this.log.error(error);
      });
  }

  async changeConfig(id, configvalue, value) {
    this.log.debug(
      JSON.stringify({
        [configvalue]: value,
      }),
    );
    return await axios
      .post(
        `${apiUrl}/api/chargers/${id}/settings`,
        {
          [configvalue]: value,
        },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      .then((response) => {
        this.log.info("Config update successful");
        this.log.debug(JSON.stringify(response.data));
      })
      .catch((error) => {
        this.log.error("Config update error");
        this.log.error(error);
      });
  }

  //circuitMaxCurrentPX
  async changeMaxCircuitConfig(site_id, circuit_id, value) {
    return await axios
      .post(
        `${apiUrl}/api/sites/${site_id}/circuits/${circuit_id}/settings`,
        {
          maxCircuitCurrentP1: value,
          maxCircuitCurrentP2: value,
          maxCircuitCurrentP3: value,
        },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      .then((response) => {
        this.log.info("CircuitMax update successful");
        this.log.debug(JSON.stringify(response.data));
      })
      .catch((error) => {
        this.log.error("CircuitMax update error");
        this.log.error(error);
      });
  }

  //dynamicCircuitCurrentPX
  async changeCircuitConfig(site_id, circuit_id, currentValues) {
    //Der Wert darf nur für 3 Fach Werte aktualisiert werden
    await axios
      .post(
        `${apiUrl}/api/sites/${site_id}/circuits/${circuit_id}/settings`,
        {
          dynamicCircuitCurrentP1: currentValues.p1,
          dynamicCircuitCurrentP2: currentValues.p2,
          dynamicCircuitCurrentP3: currentValues.p3,
        },
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: apiRequestTimeout,
        },
      )
      .then((response) => {
        this.log.info("Circuit update successful");
        this.log.debug(JSON.stringify(response.data));
        return response;
      })
      .catch((error) => {
        this.log.error("Circuit update error");
        this.log.error(error);
      });
  }

  /***********************************************************************
   * Funktionen zum erstellen der Objekte der Reading
   ***********************************************************************/

  async setAllStatusObjects(charger) {
    //Legen die Steuerungsbutton für jeden Charger an
    await this.setObjectNotExistsAsync(`${charger.id}.control.start`, {
      type: "state",
      common: {
        name: "Start charging",
        type: "boolean",
        role: "button",
        read: true,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.control.start`);

    await this.setObjectNotExistsAsync(`${charger.id}.control.stop`, {
      type: "state",
      common: {
        name: "Stop charging",
        type: "boolean",
        role: "button",
        read: false,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.control.stop`);

    await this.setObjectNotExistsAsync(`${charger.id}.control.pause`, {
      type: "state",
      common: {
        name: "Pause charging",
        type: "boolean",
        role: "button",
        read: false,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.control.pause`);

    await this.setObjectNotExistsAsync(`${charger.id}.control.resume`, {
      type: "state",
      common: {
        name: "Resume charging",
        type: "boolean",
        role: "button",
        read: false,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.control.resume`);

    await this.setObjectNotExistsAsync(`${charger.id}.control.reboot`, {
      type: "state",
      common: {
        name: "Reboot Charger",
        type: "boolean",
        role: "button",
        read: true,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.control.reboot`);

    //id
    await this.setObjectNotExistsAsync(`${charger.id}.id`, {
      type: "state",
      common: {
        name: "id",
        type: "string",
        role: "info.name",
        read: true,
        write: false,
      },
      native: {},
    });
    await this.setStateAsync(`${charger.id}.id`, charger.id, true);

    //name
    await this.setObjectNotExistsAsync(`${charger.id}.name`, {
      type: "state",
      common: {
        name: "name",
        type: "string",
        role: "info.name",
        read: true,
        write: false,
      },
      native: {},
    });

    //"cableLocked": true,
    await this.setObjectNotExistsAsync(`${charger.id}.status.cableLocked`, {
      type: "state",
      common: {
        name: "Cable lock state",
        type: "boolean",
        role: "sensor.lock",
        read: true,
        write: false,
      },
      native: {},
    });

    //"chargerOpMode": 1,
    await this.setObjectNotExistsAsync(`${charger.id}.status.chargerOpMode`, {
      type: "state",
      common: {
        name: "Charger operation mode according to charger mode table",
        type: "number",
        role: "value",
        read: true,
        write: false,
      },
      native: {},
    });

    //"totalPower": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.totalPower`, {
      type: "state",
      common: {
        name: "Total power [kW]",
        type: "number",
        role: "value.power",
        read: true,
        write: false,
        unit: "kW",
      },
      native: {},
    });

    //"wiFiRSSI": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.wiFiRSSI`, {
      type: "state",
      common: {
        name: "WiFi signal strength [dBm]",
        type: "number",
        role: "value",
        read: true,
        write: false,
        unit: "dBm",
      },
      native: {},
    });

    //"chargerFirmware": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.chargerFirmware`, {
      type: "state",
      common: {
        name: "Modem firmware version",
        type: "number",
        role: "info.firmware",
        read: true,
        write: false,
      },
      native: {},
    });

    //"reasonForNoCurrent": 0,
    await this.setObjectNotExistsAsync(
      `${charger.id}.status.reasonForNoCurrent`,
      {
        type: "state",
        common: {
          name: "Reason for not offering current to the car",
          type: "number",
          role: "value",
          read: true,
          write: false,
        },
        native: {},
      },
    );

    //"voltage": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.voltage`, {
      type: "state",
      common: {
        name: "voltage",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });

    //"outputCurrent": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.outputCurrent`, {
      type: "state",
      common: {
        name: "Active output phase(s) to EV according to output phase type table.",
        type: "number",
        role: "value.current",
        read: true,
        write: false,
        unit: "A",
      },
      native: {},
    });

    //"inCurrentT2": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inCurrentT2`, {
      type: "state",
      common: {
        name: "Current RMS for input T2 [Amperes]",
        type: "number",
        role: "value.current",
        read: true,
        write: false,
        unit: "A",
      },
      native: {},
    });

    //"inCurrentT3": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inCurrentT3`, {
      type: "state",
      common: {
        name: "Current RMS for input T3 [Amperes]",
        type: "number",
        role: "value.current",
        read: true,
        write: false,
        unit: "A",
      },
      native: {},
    });

    //"inCurrentT4": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inCurrentT4`, {
      type: "state",
      common: {
        name: "Current RMS for input T4 [Amperes]",
        type: "number",
        role: "value.current",
        read: true,
        write: false,
        unit: "A",
      },
      native: {},
    });

    //"inCurrentT5": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inCurrentT5`, {
      type: "state",
      common: {
        name: "Current RMS for input T5 [Amperes]",
        type: "number",
        role: "value.current",
        read: true,
        write: false,
        unit: "A",
      },
      native: {},
    });

    //"inVoltageT1T2": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT1T2`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T1 and T2 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT1T3": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT1T3`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T1 and T3 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT1T4": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT1T4`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T1 and T4 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT1T5": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT1T5`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T1 and T5 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT2T3": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT2T3`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T2 and T3 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT2T4": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT2T4`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T2 and T4 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT2T5": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT2T5`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T2 and T5 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT3T4": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT3T4`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T3 and T4 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT3T5": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT3T5`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T3 and T5 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });
    //"inVoltageT4T5": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.inVoltageT4T5`, {
      type: "state",
      common: {
        name: "Current Voltage for between inputs T4 and T5 [Volts]",
        type: "number",
        role: "value.voltage",
        read: true,
        write: false,
        unit: "V",
      },
      native: {},
    });

    //"isOnline": true,
    await this.setObjectNotExistsAsync(`${charger.id}.status.isOnline`, {
      type: "state",
      common: {
        name: "isOnline",
        type: "boolean",
        role: "indicator.reachable",
        read: true,
        write: false,
      },
      native: {},
    });

    //"wiFiAPEnabled": true,
    await this.setObjectNotExistsAsync(`${charger.id}.status.wiFiAPEnabled`, {
      type: "state",
      common: {
        name: "True if WiFi Access Point is enabled, otherwise false",
        type: "boolean",
        role: "indicator",
        read: true,
        write: false,
      },
      native: {},
    });

    //"ledMode": true,
    await this.setObjectNotExistsAsync(`${charger.id}.status.ledMode`, {
      type: "state",
      common: {
        name: "Charger LED mode",
        type: "number",
        role: "value",
        read: true,
        write: false,
      },
      native: {},
    });

    //"lifetimeEnergy": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.lifetimeEnergy`, {
      type: "state",
      common: {
        name: "Accumulated energy in the lifetime of the charger [kWh]",
        type: "number",
        role: "value.power.consumption",
        read: true,
        write: false,
        unit: "kWh",
      },
      native: {},
    });

    //"energyPerHour": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.energyPerHour`, {
      type: "state",
      common: {
        name: "Accumulated energy per hour [kWh]",
        type: "number",
        role: "value.power.consumption",
        read: true,
        write: false,
        unit: "kWh",
      },
      native: {},
    });

    //"energyPerHour": 0,
    await this.setObjectNotExistsAsync(`${charger.id}.status.energyPerHour`, {
      type: "state",
      common: {
        name: "Accumulated energy per hour [kWh]",
        type: "number",
        role: "value.power.consumption",
        read: true,
        write: false,
        unit: "kWh",
      },
      native: {},
    });

    // Ab hier nur Objekte die über SignalR kommen
    //TempMax
    await this.setObjectNotExistsAsync(`${charger.id}.status.TempMax`, {
      type: "state",
      common: {
        name: "SignaleR only: Maximum temperature for all sensors [Celsius]",
        type: "number",
        role: "value.temperature.max",
        read: true,
        write: false,
      },
      native: {},
    });
  }

  /*************** Session Reading ****************/
  async setNewSessionToCharger(charger, charger_session) {
    this.log.debug(JSON.stringify(charger_session));
    for (const session of charger_session) {
      //für jeden Monat errechnen wir das?
      await this.setObjectNotExistsAsync(
        `${charger.id}.session.${session.year}.${
          session.month
        }.totalEnergyUsage`,
        {
          type: "state",
          common: {
            name: "totalEnergyUsage",
            type: "number",
            role: "value",
            read: true,
            write: false,
          },
          native: {},
        },
      );
      await this.setStateAsync(
        `${charger.id}.session.${session.year}.${
          session.month
        }.totalEnergyUsage`,
        session.totalEnergyUsage,
        true,
      );

      await this.setObjectNotExistsAsync(
        `${charger.id}.session.${session.year}.${session.month}.totalCost`,
        {
          type: "state",
          common: {
            name: "totalCost",
            type: "number",
            role: "value",
            read: true,
            write: false,
          },
          native: {},
        },
      );
      await this.setStateAsync(
        `${charger.id}.session.${session.year}.${session.month}.totalCost`,
        session.totalCost,
        true,
      );

      await this.setObjectNotExistsAsync(
        `${charger.id}.session.${session.year}.total_year`,
        {
          type: "state",
          common: {
            name: "total_year",
            type: "number",
            role: "value",
            read: true,
            write: false,
          },
          native: {},
        },
      );
    }

    let tmpYear = 1970;
    let tmpYearCount = 0;
    for (const session of charger_session) {
      //Jahreszähler umhängen
      this.log.debug("set session year data");
      if (tmpYear != session.year) {
        //neues Jahr setzen alles zurück
        await this.setStateAsync(
          `${charger.id}.session.${session.year}.total_year`,
          session.totalEnergyUsage,
          true,
        );
        tmpYearCount = session.totalEnergyUsage;
        tmpYear = session.year;
      } else {
        tmpYearCount = tmpYearCount + session.totalEnergyUsage;
        await this.setStateAsync(
          `${charger.id}.session.${session.year}.total_year`,
          tmpYearCount,
          true,
        );
      }
    }
  }

  /*************** Config Reading ****************/
  async setAllConfigObjects(charger) {
    //isEnabled
    await this.setObjectNotExistsAsync(`${charger.id}.config.isEnabled`, {
      type: "state",
      common: {
        name: "Set true to enable charger, false disables charger",
        type: "boolean",
        role: "switch.enabled",
        read: true,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.config.isEnabled`);

    //phaseMode
    await this.setObjectNotExistsAsync(`${charger.id}.config.phaseMode`, {
      type: "state",
      common: {
        name: "Phase mode on this charger. 1-Locked to 1-Phase, 2-Auto, 3-Locked to 3-phase(only Home)",
        type: "number",
        role: "level",
        read: true,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.config.phaseMode`);

    //maxChargerCurrent
    await this.setObjectNotExistsAsync(
      `${charger.id}.config.maxChargerCurrent`,
      {
        type: "state",
        common: {
          name: "Max current this charger is allowed to offer to car (A)",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.maxChargerCurrent`);

    //dynamicChargerCurrent
    await this.setObjectNotExistsAsync(
      `${charger.id}.config.dynamicChargerCurrent`,
      {
        type: "state",
        common: {
          name: "Dynamic max current this charger is allowed to offer to car (A)",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.dynamicChargerCurrent`);

    await this.setObjectNotExistsAsync(
      `${charger.id}.config.dynamicCircuitCurrentP1`,
      {
        type: "state",
        common: {
          name: "Dynamically set circuit maximum current for phase 1 [Amperes]",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.dynamicCircuitCurrentP1`);

    await this.setObjectNotExistsAsync(
      `${charger.id}.config.dynamicCircuitCurrentP2`,
      {
        type: "state",
        common: {
          name: "Dynamically set circuit maximum current for phase 2 [Amperes]",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.dynamicCircuitCurrentP2`);

    await this.setObjectNotExistsAsync(
      `${charger.id}.config.dynamicCircuitCurrentP3`,
      {
        type: "state",
        common: {
          name: "Dynamically set circuit maximum current for phase 3 [Amperes]",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.dynamicCircuitCurrentP3`);

    await this.setObjectNotExistsAsync(
      `${charger.id}.config.circuitMaxCurrentP1`,
      {
        type: "state",
        common: {
          name: "Set circuit maximum current [Amperes]",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.circuitMaxCurrentP1`);

    await this.setObjectNotExistsAsync(
      `${charger.id}.config.circuitMaxCurrentP2`,
      {
        type: "state",
        common: {
          name: "Set circuit maximum current [Amperes]",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.circuitMaxCurrentP2`);

    await this.setObjectNotExistsAsync(
      `${charger.id}.config.circuitMaxCurrentP3`,
      {
        type: "state",
        common: {
          name: "Set circuit maximum current [Amperes]",
          type: "number",
          role: "level.current",
          read: true,
          write: true,
          unit: "A",
        },
        native: {},
      },
    );
    //this.subscribeStates(charger.id + '.config.circuitMaxCurrentP3');

    //ledStripBrightness
    await this.setObjectNotExistsAsync(
      `${charger.id}.config.ledStripBrightness`,
      {
        type: "state",
        common: {
          name: "LED strip brightness, 0-100%",
          type: "number",
          role: "level.brightness",
          read: true,
          write: true,
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.ledStripBrightness`);

    //"smartCharging": true,
    await this.setObjectNotExistsAsync(`${charger.id}.config.smartCharging`, {
      type: "state",
      common: {
        name: "Smart charging state enabled by capacitive touch button",
        type: "boolean",
        role: "switch.enable",
        read: true,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.config.smartCharging`);

    //smartButtonEnabled
    await this.setObjectNotExistsAsync(
      `${charger.id}.config.smartButtonEnabled`,
      {
        type: "state",
        common: {
          name: "Smart Button Enabled/Disabled",
          type: "boolean",
          role: "switch.enable",
          read: true,
          write: true,
        },
        native: {},
      },
    );
    this.subscribeStates(`${charger.id}.config.smartButtonEnabled`);

    //wiFiSSID
    await this.setObjectNotExistsAsync(`${charger.id}.config.wiFiSSID`, {
      type: "state",
      common: {
        name: "WiFi SSID name",
        type: "string",
        role: "text",
        read: true,
        write: true,
      },
      native: {},
    });
    this.subscribeStates(`${charger.id}.config.wiFiSSID`);
  }
}

if (module.parent) {
  // Export the constructor in compact mode
  module.exports = (options) => new Easee(options);
  module.exports.Easee = Easee;
} else {
  // otherwise start the instance directly
  new Easee();
}
