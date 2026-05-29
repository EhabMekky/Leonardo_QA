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

import { chromium, firefox, devices } from 'playwright';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { executeInteraction, dismissCommonPopups, runFailureDiagnostics } from './interaction-helper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Valid actions that can appear in CSV */
const VALID_ACTIONS = ['navigate', 'click', 'fill', 'screenshot', 'wait'];

/** Default retry configuration */
const MAX_RETRIES = 1;
const RETRY_WAIT_MS = 1000;
const ACTION_TIMEOUT_MS = 5000;

/**
 * Run a scripted test from a CSV file buffer
 * @param {Object} options - Test options
 * @param {string} options.url - Target URL to test
 * @param {Array} options.cookies - Array of cookie objects to inject
 * @param {Buffer|string} options.csvContent - CSV file content (buffer or string)
 * @param {string} options.model - Ollama model name (for report metadata)
 * @param {string} options.ollamaUrl - Ollama base URL
 * @param {string} options.runId - Unique run ID
 * @param {Function} options.onProgress - Callback for progress updates (step, status, message)
 * @returns {Object} Test results with steps, screenshots, errors, duration
 */
export async function runScriptedTest(options) {
  const {
    url,
    cookies = [],
    csvContent,
    model = 'N/A',
    ollamaUrl = 'http://127.0.0.1:11434',
    runId,
    onProgress = () => {},
    signal,
    browserName = 'chrome',
    deviceProfile = 'desktop'
  } = options;

  const startTime = new Date();
  const steps = [];
  const consoleErrors = [];
  let browser = null;
  let context = null;
  let page = null;
  let videoDir = null;

  const abortHandler = async () => {
    onProgress({ type: 'status', message: 'Test cancelled by user.' });
    if (page) {
      try { await page.close(); } catch (_) {}
    }
    if (context) {
      try { await context.close(); } catch (_) {}
    }
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  };

  if (signal) {
    if (signal.aborted) {
      throw new Error('Test run cancelled by user');
    }
    signal.addEventListener('abort', abortHandler);
  }

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
    onProgress({ type: 'status', message: `Launching browser ${browserName}...` });
    if (browserName === 'firefox') {
      browser = await firefox.launch({
        headless: false,
        slowMo: 300
      });
    } else if (browserName === 'edge') {
      browser = await chromium.launch({
        headless: false,
        slowMo: 300,
        channel: 'msedge'
      });
    } else {
      browser = await chromium.launch({
        headless: false,
        slowMo: 300
      });
    }

    videoDir = runId ? path.join(__dirname, 'reports', runId, 'videos') : null;
    const contextOptions = {
      viewport: { width: 1280, height: 720 },
      ...(videoDir ? { recordVideo: { dir: videoDir } } : {})
    };

    if (deviceProfile && deviceProfile !== 'desktop') {
      let profileName = deviceProfile;
      if (profileName === 'Galaxy S22' && !devices[profileName]) {
        profileName = 'Galaxy S24';
      }
      const deviceConfig = devices[profileName] || {};
      Object.assign(contextOptions, deviceConfig);
    }

    context = await browser.newContext(contextOptions);

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

        // Aggressively dismiss popups with retries — cookie banners (e.g. CookieYes)
        // load asynchronously and may not appear immediately after domcontentloaded.
        // We retry up to 3 times with 1-second gaps to make sure they are fully gone
        // before the first test step runs. This prevents Escape key workarounds from
        // firing when a login modal is open later in the test.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const dismissed = await dismissCommonPopups(page);
            if (dismissed) {
              onProgress({ type: 'info', message: `Dismissed popup(s) on attempt ${attempt + 1}` });
            }
          } catch (popupErr) {
            console.warn(`[Scripted Test] dismissCommonPopups attempt ${attempt + 1} failed: ${popupErr.message}`);
          }
          // Short wait between attempts so async banners have time to appear/disappear
          await page.waitForTimeout(1000);
        }

        // Final settle wait to let any remaining animations complete
        await page.waitForTimeout(500);

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
        const diagnostics = await runFailureDiagnostics({
          page,
          action: 'navigate',
          selector: '',
          value: url,
          errorMsg: err.message,
          model,
          ollamaUrl
        });

        steps.push({
          name: `Navigate to ${url}`,
          action: 'navigate',
          selector: '',
          value: url,
          status: 'failed',
          duration: Date.now() - navStart,
          error: err.message,
          screenshot: await captureScreenshot(page),
          reason: '',
          diagnostics
        });
        throw new Error(`Initial navigation failed: ${err.message}`);
      }
    }

    // --- Execute each CSV row ---
    for (let i = 0; i < records.length; i++) {
      if (signal?.aborted) {
        throw new Error('Test run cancelled by user');
      }
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

      const stepResult = await executeActionWithRetry(page, action, selector, value, stepName, signal, model, ollamaUrl);
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

      if (stepResult.status === 'failed') {
        onProgress({
          type: 'info',
          message: `Step ${i + 1} failed. Halting further step execution and generating report.`
        });
        break;
      }
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
    if (signal) {
      signal.removeEventListener('abort', abortHandler);
    }
    // --- Cleanup ---
    if (!signal?.aborted) {
      let videoPath = null;
      if (videoDir && page) {
        try {
          const video = page.video();
          if (video) {
            videoPath = await video.path();
          }
        } catch (err) {
          console.warn('Failed to retrieve video path:', err);
        }
      }

      if (page) {
        try { await page.close(); } catch (_) { /* ignore */ }
      }
      if (context) {
        try { await context.close(); } catch (_) { /* ignore */ }
      }
      if (browser) {
        try { await browser.close(); } catch (_) { /* ignore */ }
      }

      if (videoPath && fs.existsSync(videoPath)) {
        const hasFailure = steps.some(s => s.status === 'failed');
        if (hasFailure) {
          const targetVideoPath = path.join(__dirname, 'reports', runId, `video-${browserName}.webm`);
          try {
            fs.mkdirSync(path.dirname(targetVideoPath), { recursive: true });
            fs.copyFileSync(videoPath, targetVideoPath);
            onProgress({ type: 'info', message: `Video recorded for failure scenario: video-${browserName}.webm` });
          } catch (err) {
            console.warn(`Failed to copy video to final destination: ${err.message}`);
          }
        }
        try {
          fs.rmSync(videoDir, { recursive: true, force: true });
        } catch (err) {
          console.warn(`Failed to clean up temporary videos folder: ${err.message}`);
        }
      }
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
 * @param {Object} signal - Abort signal
 * @param {string} model - Model name
 * @param {string} ollamaUrl - Ollama URL
 * @returns {Object} Step result with status, duration, error, screenshot
 */
async function executeActionWithRetry(page, action, selector, value, stepName, signal, model, ollamaUrl) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) {
      throw new Error('Test run cancelled by user');
    }
    const stepStart = Date.now();

    try {
      const interactionResult = await executeAction(page, action, selector, value);

      if (signal?.aborted) {
        throw new Error('Test run cancelled by user');
      }

      // Capture screenshot after successful action
      const screenshot = await captureScreenshot(page);

      let reason = '';
      if (interactionResult && interactionResult.healed) {
        reason = `Self-healed: ${interactionResult.healMethod} -> ${interactionResult.resolvedSelector}`;
      }
      if (attempt > 1) {
        reason = reason ? `${reason} (Passed on retry #${attempt})` : `Passed on retry #${attempt}`;
      }

      return {
        name: stepName,
        action,
        selector,
        value,
        status: 'passed',
        duration: Date.now() - stepStart,
        error: null,
        screenshot,
        reason
      };

    } catch (error) {
      if (signal?.aborted) {
        throw new Error('Test run cancelled by user');
      }
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
  if (signal?.aborted) {
    throw new Error('Test run cancelled by user');
  }
  const screenshot = await captureScreenshot(page);

  const diagnostics = await runFailureDiagnostics({
    page,
    action,
    selector,
    value,
    errorMsg: lastError?.message || 'Unknown error',
    model,
    ollamaUrl
  });

  return {
    name: stepName,
    action,
    selector,
    value,
    status: 'failed',
    duration: 0,
    error: lastError?.message || 'Unknown error',
    screenshot,
    reason: `Failed after ${MAX_RETRIES} attempts`,
    diagnostics
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
  let interactionResult = null;
  switch (action) {
    case 'navigate': {
      // Guard against LLM-generated placeholder values like "empty", "N/A", "none", etc.
      const navUrl = [value, selector].find(
        v => v && v.trim().length > 0 && /^https?:\/\//i.test(v.trim())
      );
      if (!navUrl) throw new Error(`Navigate action has no valid URL. Selector: "${selector}", Value: "${value}"`);
      await page.goto(navUrl.trim(), {
        waitUntil: 'domcontentloaded',
        timeout: ACTION_TIMEOUT_MS
      });
      // Dismiss any popups that appear after navigation (e.g. cookie banners)
      await page.waitForTimeout(1000);
      try { await dismissCommonPopups(page); } catch (_) {}
      await page.waitForTimeout(500);
      break;
    }

    case 'click':
      if (!selector) throw new Error('Click action requires a Selector');
      interactionResult = await executeInteraction(page, 'click', selector, '', ACTION_TIMEOUT_MS);
      if (interactionResult.status === 'failed') throw new Error(interactionResult.error);
       // Wait for navigation/animation — increased to 1500ms so modal open animations
       // (e.g. login modal slide-in) have time to fully complete before the next step.
      await page.waitForTimeout(1500);
      break;

    case 'fill':
      if (!selector) throw new Error('Fill action requires a Selector');
      if (!value) throw new Error('Fill action requires a Value');
      interactionResult = await executeInteraction(page, 'fill', selector, value, ACTION_TIMEOUT_MS);
      if (interactionResult.status === 'failed') throw new Error(interactionResult.error);
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
  return interactionResult;
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
