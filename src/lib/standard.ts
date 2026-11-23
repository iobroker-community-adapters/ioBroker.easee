/**
 * The standard commands of the shared catalog (family "vehicle", HELP.md of ioBroker.assistant): a wallbox counts
 * as a vehicle for `charge` and `setChargeCurrent`. Thin wrappers over the charger functions of main.ts (see
 * `standardTarget` there). Answers: success without `error`, failure `{error, reason}`.
 */

/** command -> standard name */
export const STANDARD_COMMANDS: Record<string, string> = {
  getVehicles: "vehicle.getVehicles",
  charge: "vehicle.charge",
  setChargeCurrent: "vehicle.setChargeCurrent",
};

/** Rule 9 of the catalog: a command that takes longer answers {ok: true, pending: true} */
const PENDING_MS = 14000;

export interface StandardCharger {
  id: string;
  name: string;
}

/** What the standard commands need of the instance; the functions throw an Error, optionally with `code` */
export interface StandardTarget {
  chargers(): Promise<StandardCharger[]>;
  charge(id: string, on: boolean): Promise<void>;
  setCurrent(id: string, amps: number): Promise<void>;
  warn(text: string): void;
}

export type StandardAnswer = Record<string, unknown>;

function fail(
  error: string,
  reason: string,
  extra: Record<string, unknown> = {},
): StandardAnswer {
  return { error, reason, ...extra };
}

function bool(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === 1) {
    return true;
  }
  if (value === false || value === "false" || value === 0) {
    return false;
  }
  return undefined;
}

/** `vehicle` = serial number or name (exact before partial), default the only charger */
async function findCharger(
  target: StandardTarget,
  wanted: unknown,
): Promise<{ charger?: StandardCharger; error?: StandardAnswer }> {
  const chargers = await target.chargers();
  if (!chargers.length) {
    return { error: fail("No Easee charger configured", "NOT_FOUND") };
  }
  const names = (list: StandardCharger[]): string[] => list.map((c) => c.name);
  const given =
    typeof wanted === "string" || typeof wanted === "number"
      ? String(wanted).trim()
      : "";
  const text = given.toLowerCase();
  if (!text) {
    return chargers.length === 1
      ? { charger: chargers[0] }
      : {
          error: fail("Several chargers: which one?", "AMBIGUOUS", {
            candidates: names(chargers),
          }),
        };
  }
  const exact = chargers.filter(
    (c) => c.id.toLowerCase() === text || c.name.toLowerCase() === text,
  );
  const hits = exact.length
    ? exact
    : chargers.filter((c) => c.name.toLowerCase().includes(text));
  if (hits.length === 1) {
    return { charger: hits[0] };
  }
  return hits.length
    ? {
        error: fail(`"${given}" fits several chargers`, "AMBIGUOUS", {
          candidates: names(hits),
        }),
      }
    : {
        error: fail(`Unknown charger "${given}"`, "NOT_FOUND", {
          candidates: names(chargers),
        }),
      };
}

/** Rule 9: the answer of `job`, or {ok: true, pending: true} after `ms` while it goes on in the background */
function inTime(
  target: StandardTarget,
  label: string,
  job: Promise<void>,
  ms: number,
): Promise<StandardAnswer> {
  let timer: NodeJS.Timeout | undefined;
  let late = false;
  const pending = new Promise<StandardAnswer>((resolve) => {
    timer = setTimeout(() => {
      late = true;
      resolve({ ok: true, pending: true });
    }, ms);
  });
  const done = job
    .then((): StandardAnswer => ({ ok: true }))
    .catch((error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      return fail(
        error instanceof Error ? error.message : String(error),
        typeof code === "string" ? code : "COMMAND_FAILED",
      );
    })
    .then((answer) => {
      clearTimeout(timer);
      if (late && typeof answer.error === "string") {
        target.warn(`${label}: ${answer.error}`);
      }
      return answer;
    });
  return Promise.race([done, pending]);
}

/**
 * @param target the functions of the instance
 * @param command a key of STANDARD_COMMANDS
 * @param message the parameters of the catalog
 * @param pendingMs after this time a write answers {ok: true, pending: true}
 */
export async function handleStandardCommand(
  target: StandardTarget,
  command: string,
  message: unknown,
  pendingMs = PENDING_MS,
): Promise<StandardAnswer> {
  const msg: Record<string, unknown> =
    message && typeof message === "object"
      ? (message as Record<string, unknown>)
      : {};
  try {
    if (command === "getVehicles") {
      const chargers = await target.chargers();
      return { vehicles: chargers.map((c) => ({ ...c, kind: "wallbox" })) };
    }
    const found = await findCharger(target, msg.vehicle);
    if (!found.charger) {
      return found.error ?? fail("No charger", "NOT_FOUND");
    }
    const { id, name } = found.charger;
    if (command === "charge") {
      const on = bool(msg.on);
      if (on === undefined) {
        return fail("on (true or false) is required", "BAD_REQUEST");
      }
      return await inTime(
        target,
        `charge ${name}`,
        target.charge(id, on),
        pendingMs,
      );
    }
    if (command === "setChargeCurrent") {
      const amps =
        typeof msg.amps === "string" && msg.amps.trim() !== ""
          ? Number(msg.amps)
          : msg.amps;
      if (typeof amps !== "number" || !Number.isFinite(amps) || amps < 0) {
        return fail("amps: a number of A (0 = no charging)", "BAD_REQUEST");
      }
      return await inTime(
        target,
        `setChargeCurrent ${name}`,
        target.setCurrent(id, amps),
        pendingMs,
      );
    }
    return fail(`Unknown command ${command}`, "NOT_SUPPORTED");
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : String(error),
      "COMMAND_FAILED",
    );
  }
}
