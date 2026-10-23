import axios from "axios";
import type { AxiosError } from "axios";

/**
 * Tests whether the given variable is a real object and not an Array
 *
 * @param it The variable to test
 * @returns True if the variable is an object, false otherwise
 */
export function isObject(it: unknown): it is Record<string, unknown> {
  return Object.prototype.toString.call(it) === "[object Object]";
}

/**
 * Tests whether the given variable is really an Array
 *
 * @param it The variable to test
 * @returns True if the variable is an array, false otherwise
 */
export function isArray(it: unknown): it is unknown[] {
  return Array.isArray(it);
}

/**
 * Translates text to the target language. Automatically chooses the right translation API.
 *
 * @param text The text to translate
 * @param targetLang The target language
 * @param [yandexApiKey] The yandex API key. You can create one for free at https://translate.yandex.com/developers
 * @returns The translated text
 */
export async function translateText(
  text: string,
  targetLang: string,
  yandexApiKey?: string,
): Promise<string> {
  if (!text) {
    return "";
  }
  if (targetLang === "en") {
    return text;
  }

  return yandexApiKey
    ? translateYandex(text, targetLang, yandexApiKey)
    : translateGoogle(text, targetLang);
}

/**
 * Translates text with Yandex API
 *
 * @param text The text to translate
 * @param targetLang The target language
 * @param apiKey The yandex API key. You can create one for free at https://translate.yandex.com/developers
 * @returns The translated text
 */
async function translateYandex(
  text: string,
  targetLang: string,
  apiKey: string,
): Promise<string> {
  if (targetLang === "zh-cn") {
    targetLang = "zh";
  }

  const url = `https://translate.yandex.net/api/v1.5/tr.json/translate?key=${apiKey}&text=${encodeURIComponent(text)}&lang=en-${targetLang}`;
  try {
    const response = await axios.get(url, { timeout: 15000 });
    if (response.data?.text && isArray(response.data.text)) {
      return response.data.text[0];
    }
    throw new Error("Invalid response for translate request");
  } catch (error) {
    throw new Error(
      `Could not translate to "${targetLang}": ${getErrorMessage(error)}`,
    );
  }
}

/**
 * Translates text with Google API
 *
 * @param text The text to translate
 * @param targetLang The target language
 * @returns The translated text
 */
async function translateGoogle(
  text: string,
  targetLang: string,
): Promise<string> {
  const url = `http://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}&ie=UTF-8&oe=UTF-8`;
  try {
    const response = await axios.get<unknown>(url, { timeout: 15000 });
    const translation = response.data;
    if (
      Array.isArray(translation) &&
      Array.isArray(translation[0]) &&
      Array.isArray(translation[0][0]) &&
      typeof translation[0][0][0] === "string"
    ) {
      return translation[0][0][0];
    }
    throw new Error("Invalid response for translate request");
  } catch (error) {
    const response = axios.isAxiosError(error)
      ? (error as AxiosError).response
      : undefined;
    const detail =
      response?.status === 429
        ? `Rate-limited by Google Translate`
        : getErrorMessage(error);
    throw new Error(`Could not translate to "${targetLang}": ${detail}`);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { translateYandex, translateGoogle };
