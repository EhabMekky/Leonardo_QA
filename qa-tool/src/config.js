/**
 * config.js — Centralized runtime configuration
 *
 * Loads variables from `qa-tool/.env` (if present) using Node's built-in
 * `process.loadEnvFile` (Node >= 20.12), then exposes typed config values.
 * Real environment variables always take precedence over the .env file.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', '.env');

if (fs.existsSync(ENV_PATH)) {
  try {
    process.loadEnvFile(ENV_PATH);
  } catch (err) {
    console.warn(`[CONFIG] Failed to load .env file: ${err.message}`);
  }
}

/** Parse a boolean env var ("true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off"). */
function parseBool(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  console.warn(`[CONFIG] Invalid boolean value "${value}", using default: ${fallback}`);
  return fallback;
}

/** Parse a non-negative integer env var. Returns `fallback` if unset/invalid. */
function parseIntSafe(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    console.warn(`[CONFIG] Invalid integer value "${value}", using default: ${fallback}`);
    return fallback;
  }
  return n;
}

export const config = {
  port: parseIntSafe(process.env.PORT, 3000),
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  browser: {
    /** Run browsers without a visible window. */
    headless: parseBool(process.env.HEADLESS, false),
    /** Global slowMo override in ms. `null` means each engine uses its own default. */
    slowMo: parseIntSafe(process.env.SLOW_MO, null)
  }
};

/**
 * Build Playwright launch options for a given browser.
 * @param {string} browserName - 'chrome' | 'firefox' | 'edge'
 * @param {number} defaultSlowMo - Engine-specific slowMo used when SLOW_MO is not set
 */
export function getLaunchOptions(browserName, defaultSlowMo = 300) {
  const options = {
    headless: config.browser.headless,
    slowMo: config.browser.slowMo ?? defaultSlowMo
  };
  if (browserName === 'edge') options.channel = 'msedge';
  return options;
}

/** Human-readable label for reports, e.g. "Headless" or "Headed". */
export function getBrowserModeLabel() {
  return config.browser.headless ? 'Headless' : 'Headed';
}

