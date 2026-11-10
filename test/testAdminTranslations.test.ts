"use strict";

export {};

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { describe, it } from "mocha";

const languages = [
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
] as const;
const deviceManagerKeys = [
  "Add Bluetooth charger",
  "Charger saved. Restart the adapter to apply the change.",
  "Bluetooth configuration error: %s",
  "Clear configuration",
  "This clears all saved Bluetooth chargers and PINs. Continue?",
  "Could not clear the stored Bluetooth configuration.",
  "Bluetooth configuration cleared. Add chargers again in the Device Manager and restart the adapter.",
  "Bluetooth charger is not configured.",
  "Edit",
  "Edit Bluetooth charger",
  "Remove",
  "Remove this Bluetooth charger?",
  "Charger removed. Restart the adapter to apply the change.",
  "Stored Bluetooth charger configuration could not be read.",
  "Stored setting %s, entry %s, field %s",
  "Stored entry %s, field %s",
  "Stored field %s",
  "Bluetooth charger entry %s, field %s",
  "Bluetooth charger field %s",
  "%s: %s.",
  "The charger could not be saved because the existing stored Bluetooth configuration is invalid: %s",
  "The charger could not be removed because the existing stored Bluetooth configuration is invalid: %s",
  "The submitted Bluetooth charger data is invalid: %s",
  "The charger could not be saved. Check the serial number, PIN, and duplicate chargers.",
  "The charger could not be removed from the configuration.",
  "Stored Bluetooth charger entry %s field pin could not be decrypted.",
  "Stored Bluetooth charger entry %s field pin did not decrypt to a non-empty string.",
  "must be a list",
  "must be an object",
  "is invalid; expected an object",
  "needs a valid serial number",
  "must be a string",
  "needs a Bluetooth PIN",
  "Duplicate Bluetooth charger serial number",
  "Configure at least one Bluetooth charger",
] as const;

type TranslationDictionary = Record<string, string>;

function readTranslations(
  language: (typeof languages)[number],
): TranslationDictionary {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "admin", "i18n", `${language}.json`),
      "utf8",
    ),
  ) as TranslationDictionary;
}

describe("Device Manager translations", () => {
  it("provides complete, translated strings with matching placeholders in every locale", () => {
    const translations = Object.fromEntries(
      languages.map((language) => [language, readTranslations(language)]),
    ) as Record<(typeof languages)[number], TranslationDictionary>;
    const english = translations.en;
    const englishKeys = Object.keys(english).sort();

    for (const language of languages) {
      expect(Object.keys(translations[language]).sort()).to.deep.equal(
        englishKeys,
      );
      for (const key of deviceManagerKeys) {
        expect(english[key]).to.equal(key);
        const value = translations[language][key];
        expect(value, `${language} is missing ${key}`).to.be.a("string").and.not
          .empty;
        expect(
          value.match(/%s/g)?.length ?? 0,
          `${language} placeholder count for ${key}`,
        ).to.equal(english[key].match(/%s/g)?.length ?? 0);
        if (language !== "en" && key !== "%s: %s.") {
          expect(
            value,
            `${language} has an untranslated value for ${key}`,
          ).not.to.equal(english[key]);
        }
      }
    }
  });
});
