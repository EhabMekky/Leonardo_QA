/**
 * scripted.js — CSV-Driven Scripted Test Executor
 * 
 * Parses CSV files with format: Action,Selector,Value
 * Executes each row sequentially using Playwright with:
 * - Try-catch wrapping on every action
 * - 5-second waits and up to 3 retries on failure
 * - Automatic screenshots after each action
 * - Step-by-step timing and logging
 * 
 * Supported actions: navigate, click, fill, screenshot, wait
 */

import { chromium } from 'playwright';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Valid actions that can appear in CSV */
const VALID_ACTIONS = ['navigate', 'click', 'fill', 'screenshot', 'wait'];

/** Default retry configuration */
const MAX_RETRIES = 3;
const RETRY_WAIT_MS = 5000;
const ACTION_TIMEOUT_MS = 30000;

/**
 * Run a scripted test from a CSV file buffer
 * @param {Object} options - Test options
 * @param {string} options.url - Target URL to test
 * @param {Array} options.cookies - Array of cookie objects to inject
 * @param {Buffer|string} options.csvContent - CSV file content (buffer or string)
 * @param {string} options.model - Ollama model name (for report metadata)
 * @param {Function} options.onProgress - Callback for progress updates (step, status, message)
 * @returns {Object} Test results with steps, screenshots, errors, duration
 */
export async function runScriptedTest(options) {
  const {
    url,
    cookies = [],
    csvContent,
    model = 'N/A',
    onProgress = () => {}
  } = options;

  const startTime = new Date();
  const steps = [];
  const consoleErrors = [];
  let browser = null;
  let context = null;
  let page = null;

  try {
    // --- Parse CSV ---
    onProgress({ type: 'status', message: 'Parsing CSV file...' });
    const csvString = Buffer.isBuffer(csvContent) ? csvContent.toString('utf-8') : csvContent;
    const records = parseCSV(csvString);

    if (records.length === 0) {
      throw new Error('CSV file is empty or has no valid rows');
    }

    onProgress({ type: 'info', message: `Parsed ${records.length} test steps from CSV` });

    // --- Validate actions ---
    for (let i = 0; i < records.length; i++) {
      const action = records[i].Action?.toLowerCase().trim();
      if (!VALID_ACTIONS.includes(action)) {
        throw new Error(`Invalid action "${records[i].Action}" at row ${i + 2}. Valid actions: ${VALID_ACTIONS.join(', ')}`);
      }
    }

    // --- Launch Browser ---
    onProgress({ type: 'status', message: 'Launching browser...' });
    browser = await chromium.launch({
      headless: false,
      slowMo: 300
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });

    // --- Inject cookies ---
    if (cookies.length > 0) {
      onProgress({ type: 'info', message: `Injecting ${cookies.length} cookies...` });
      await context.addCookies(cookies);
    }

    page = await context.newPage();

    // --- Capture console errors ---
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push({
          message: msg.text(),
          timestamp: new Date().toISOString()
        });
      }
    });

    page.on('pageerror', error => {
      consoleErrors.push({
        message: error.message,
        timestamp: new Date().toISOString()
      });
    });

    // --- Navigate to initial URL ---
    if (url) {
      onProgress({ type: 'step', step: 0, total: records.length, message: `Navigating to ${url}` });
      const navStart = Date.now();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
        steps.push({
          name: `Navigate to ${url}`,
          action: 'navigate',
          selector: '',
          value: url,
          status: 'passed',
          duration: Date.now() - navStart,
          error: null,
          screenshot: await captureScreenshot(page),
          reason: ''
        });
      } catch (err) {
        steps.push({
          name: `Navigate to ${url}`,
          action: 'navigate',
          selector: '',
          value: url,
          status: 'failed',
          duration: Date.now() - navStart,
          error: err.message,
          screenshot: await captureScreenshot(page),
          reason: ''
        });
      }
    }

    // --- Execute each CSV row ---
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const action = record.Action?.toLowerCase().trim();
      const selector = record.Selector?.trim() || '';
      const value = record.Value?.trim() || '';
      const stepName = `${action}${selector ? ` → ${selector}` : ''}${value ? ` = "${value}"` : ''}`;

      onProgress({
        type: 'step',
        step: i + 1,
        total: records.length,
        message: `Step ${i + 1}/${records.length}: ${stepName}`
      });

      const stepResult = await executeActionWithRetry(page, action, selector, value, stepName);
      steps.push(stepResult);

      onProgress({
        type: 'step-result',
        step: i + 1,
        total: records.length,
        status: stepResult.status,
        message: stepResult.status === 'passed'
          ? `✅ Step ${i + 1} passed`
          : `❌ Step ${i + 1} failed: ${stepResult.error}`
      });
    }

  } catch (error) {
    onProgress({ type: 'error', message: `Fatal error: ${error.message}` });
    steps.push({
      name: 'Fatal Error',
      action: 'system',
      selector: '',
      value: '',
      status: 'failed',
      duration: 0,
      error: error.message,
      screenshot: null,
      reason: ''
    });
  } finally {
    // --- Cleanup ---
    if (page) {
      try { await page.close(); } catch (_) { /* ignore */ }
    }
    if (context) {
      try { await context.close(); } catch (_) { /* ignore */ }
    }
    if (browser) {
      try { await browser.close(); } catch (_) { /* ignore */ }
    }
  }

  const endTime = new Date();
  const results = {
    testName: 'Scripted Test (CSV)',
    url,
    mode: 'scripted',
    model,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    steps,
    consoleErrors,
    cookies
  };

  onProgress({ type: 'complete', message: 'Test execution complete', results });
  return results;
}


/**
 * Parse CSV content into array of objects
 * @param {string} csvString - Raw CSV text
 * @returns {Array<Object>} Parsed records
 */
function parseCSV(csvString) {
  try {
    const records = parse(csvString, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true
    });
    return records;
  } catch (error) {
    throw new Error(`Failed to parse CSV: ${error.message}`);
  }
}


/**
 * Execute a single Playwright action with retry logic
 * @param {import('playwright').Page} page - Playwright page
 * @param {string} action - Action name (navigate, click, fill, screenshot, wait)
 * @param {string} selector - CSS selector for the target element
 * @param {string} value - Value for fill/navigate/wait actions
 * @param {string} stepName - Human-readable step name
 * @returns {Object} Step result with status, duration, error, screenshot
 */
async function executeActionWithRetry(page, action, selector, value, stepName) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const stepStart = Date.now();

    try {
      await executeAction(page, action, selector, value);

      // Capture screenshot after successful action
      const screenshot = await captureScreenshot(page);

      return {
        name: stepName,
        action,
        selector,
        value,
        status: 'passed',
        duration: Date.now() - stepStart,
        error: null,
        screenshot,
        reason: attempt > 1 ? `Passed on retry #${attempt}` : ''
      };

    } catch (error) {
      lastError = error;
      console.warn(`⚠️ Attempt ${attempt}/${MAX_RETRIES} failed for "${stepName}": ${error.message}`);

      if (attempt < MAX_RETRIES) {
        // Wait before retrying
        console.log(`   Waiting ${RETRY_WAIT_MS / 1000}s before retry...`);
        await page.waitForTimeout(RETRY_WAIT_MS);
      }
    }
  }

  // All retries exhausted
  const screenshot = await captureScreenshot(page);
  return {
    name: stepName,
    action,
    selector,
    value,
    status: 'failed',
    duration: 0,
    error: lastError?.message || 'Unknown error',
    screenshot,
    reason: `Failed after ${MAX_RETRIES} attempts`
  };
}


/**
 * Execute a single Playwright action
 * @param {import('playwright').Page} page - Playwright page
 * @param {string} action - Action type
 * @param {string} selector - CSS selector
 * @param {string} value - Value parameter
 */
async function executeAction(page, action, selector, value) {
  switch (action) {
    case 'navigate':
      await page.goto(value || selector, {
        waitUntil: 'domcontentloaded',
        timeout: ACTION_TIMEOUT_MS
      });
      break;

    case 'click':
      if (!selector) throw new Error('Click action requires a Selector');
      await page.waitForSelector(selector, { timeout: ACTION_TIMEOUT_MS });
      await page.locator(selector).first().click();
      // Wait briefly for any navigation/animation
      await page.waitForTimeout(500);
      break;

    case 'fill':
      if (!selector) throw new Error('Fill action requires a Selector');
      if (!value) throw new Error('Fill action requires a Value');
      await page.waitForSelector(selector, { timeout: ACTION_TIMEOUT_MS });
      await page.locator(selector).first().clear();
      await page.locator(selector).first().fill(value);
      break;

    case 'screenshot':
      // Screenshot is captured automatically after every action
      // This action just waits a moment for page stability
      await page.waitForTimeout(500);
      break;

    case 'wait':
      const ms = parseInt(value) || 1000;
      await page.waitForTimeout(ms);
      break;

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}


/**
 * Capture a screenshot and return as base64 string
 * @param {import('playwright').Page} page - Playwright page
 * @returns {string|null} Base64 encoded PNG screenshot
 */
async function captureScreenshot(page) {
  try {
    const buffer = await page.screenshot({ fullPage: false });
    return buffer.toString('base64');
  } catch (error) {
    console.warn(`Failed to capture screenshot: ${error.message}`);
    return null;
  }
}
