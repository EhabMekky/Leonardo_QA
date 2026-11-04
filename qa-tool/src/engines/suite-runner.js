/**
 * suite-runner.js — Batch Test Suite Executor
 * 
 * Parses high-level regression test case CSVs with format:
 *   Test Case ID, Title, Module, Priority, Type, Preconditions, Test Data, Steps, Expected Result
 * 
 * For each test case:
 *   1. Sends steps + preconditions + expected results to Ollama for conversion to Action,Selector,Value CSV
 *   2. Opens a fresh browser context (isolated session)
 *   3. Executes converted steps using Playwright
 *   4. Captures pass/fail, screenshots, errors, duration
 *   5. On failure: records diagnostics and moves to the next test case
 * 
 * Returns aggregated suite results.
 */

import { chromium, firefox, devices } from 'playwright';
import { getLaunchOptions } from '../config.js';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { executeInteraction, dismissCommonPopups, runFailureDiagnostics } from './interaction-helper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default timeout and retry configuration */
const ACTION_TIMEOUT_MS = 8000;
const MAX_RETRIES = 1;
const RETRY_WAIT_MS = 1000;

/**
 * Detect if a CSV string is a high-level test suite format
 * @param {string} csvContent - Raw CSV text
 * @returns {boolean} True if it looks like a suite CSV
 */
export function isSuiteCSV(csvContent) {
  if (!csvContent || typeof csvContent !== 'string') return false;
  
  // Check the first line for suite-specific headers
  const firstLine = csvContent.split('\n')[0].toLowerCase();
  
  // Must have "test case id" (or "test case" + "id") AND "steps" columns
  const hasTestCaseId = firstLine.includes('test case id') || 
                        (firstLine.includes('test case') && firstLine.includes('id'));
  const hasSteps = firstLine.includes('steps');
  const hasExpectedResult = firstLine.includes('expected result') || firstLine.includes('expected');
  
  return hasTestCaseId && hasSteps && hasExpectedResult;
}


/**
 * Parse a suite CSV into structured test case objects
 * @param {string} csvString - Raw CSV text
 * @returns {Array<Object>} Array of test case objects
 */
function parseSuiteCSV(csvString) {
  try {
    const records = parse(csvString, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true
    });
    
    return records.map(record => {
      // Normalize column names (handle case variations)
      const normalized = {};
      for (const key of Object.keys(record)) {
        normalized[key.toLowerCase().trim()] = record[key];
      }
      
      return {
        id: normalized['test case id'] || normalized['id'] || '',
        title: normalized['title'] || normalized['name'] || '',
        module: normalized['module'] || normalized['category'] || '',
        priority: normalized['priority'] || 'Medium',
        type: normalized['type'] || '',
        preconditions: normalized['preconditions'] || normalized['precondition'] || '',
        testData: normalized['test data'] || normalized['data'] || '',
        steps: normalized['steps'] || normalized['step'] || '',
        expectedResult: normalized['expected result'] || normalized['expected'] || ''
      };
    }).filter(tc => tc.id && tc.steps); // Filter out empty rows
  } catch (error) {
    throw new Error(`Failed to parse suite CSV: ${error.message}`);
  }
}


/**
 * Convert a single test case's natural-language steps to Playwright Action,Selector,Value CSV
 * @param {Object} testCase - Parsed test case object
 * @param {string} model - Ollama model name
 * @param {string} ollamaUrl - Ollama base URL
 * @param {string} targetUrl - The target website URL
 * @param {AbortSignal} signal - Abort signal
 * @returns {string} Converted CSV content
 */
async function convertTestCaseToCSV(testCase, model, ollamaUrl, targetUrl, signal) {
  const baseUrl = targetUrl.replace(/\/$/, '');
  
  const prompt = `You are a senior QA automation engineer specializing in Playwright end-to-end testing. Convert the regression test case below into a precise, executable CSV test plan.

TARGET URL: ${targetUrl}

TEST CASE:
- ID: ${testCase.id}
- Title: ${testCase.title}
- Module: ${testCase.module}
- Preconditions: ${testCase.preconditions || 'None'}
- Test Data: ${testCase.testData || 'None'}
- Steps: ${testCase.steps}
- Expected Result: ${testCase.expectedResult}

OUTPUT FORMAT RULES (STRICT):
- Output ONLY valid CSV rows. Start with the header: Action,Selector,Value
- Do NOT include markdown fences, backticks, comments, blank lines between rows, or any text outside the CSV.
- Every row must have exactly 3 comma-separated columns. Empty columns must still have their comma (e.g. wait,,2000 or screenshot,,)

ACTIONS:
  navigate  | Selector: (empty)          | Value: full URL
  click     | Selector: CSS selector     | Value: (empty)
  fill      | Selector: CSS selector     | Value: text to type
  wait      | Selector: (empty)          | Value: milliseconds
  screenshot| Selector: (empty)          | Value: (empty)

IMPORTANT RULES:
1. If preconditions say "Logged in as Admin" or similar, start with login steps:
   - navigate to ${baseUrl}/web/index.php/auth/login (for OrangeHRM)
   - fill username field with Admin (or given credentials)
   - fill password field with admin123 (or given credentials)
   - click login/submit button
   - wait for dashboard to load

2. If preconditions mention being on a specific page (e.g. "On PIM > Employee List"), navigate there first.

3. SELECTOR PRIORITY — always prefer in this order:
   1. name attribute:         input[name="username"], input[name="password"]
   2. type + tag:             input[type="text"], input[type="password"], button[type="submit"]
   3. Placeholder text:       input[placeholder="Username"]
   4. CSS class:              .oxd-button--main, .oxd-input
   5. Text match (last resort): button:has-text("Login"), a:has-text("PIM")

4. For OrangeHRM specifically, common selectors:
   - Username field:  input[name="username"] or input[placeholder="Username"]
   - Password field:  input[name="password"] or input[placeholder="Password"]
   - Login button:    button[type="submit"] or button:has-text("Login")
   - Sidebar nav:     a:has-text("PIM"), a:has-text("Leave"), a:has-text("Admin"), etc.
   - Search button:   button[type="submit"]:has-text("Search")
   - Add button:      button:has-text("Add")
   - Save button:     button[type="submit"]:has-text("Save")
   - User dropdown:   .oxd-userdropdown-tab
   - Logout:          a:has-text("Logout")

5. After navigation or form submission, add: wait,,2000
6. After login, add: screenshot,, (to verify login succeeded)
7. For verification steps ("verify", "check", "should see", "observe"), add: screenshot,,
8. After clicking sidebar nav items, add: wait,,2000

EXAMPLE — Login test case:
Input: 1. Enter username "Admin" | 2. Enter password "admin123" | 3. Click "Login"
Output:
Action,Selector,Value
navigate,,${baseUrl}/web/index.php/auth/login
wait,,2000
fill,input[name="username"],Admin
fill,input[name="password"],admin123
click,button[type="submit"],
wait,,3000
screenshot,,

--- TEST CASE STEPS TO CONVERT ---
${testCase.steps}

CSV OUTPUT (header + rows only, nothing else):`;

  try {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener('abort', onAbort);
      }
    }

    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false
      }),
      signal: controller.signal
    });

    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status} during test case conversion`);
    }

    const data = await response.json();
    let csv = data.response || '';

    // Clean up markdown blocks if Ollama included them
    let cleaned = csv.replace(/```(?:csv)?/g, '').trim();

    // Extract from "Action,Selector,Value" header onward
    const headerIndex = cleaned.toLowerCase().indexOf('action,selector,value');
    if (headerIndex !== -1) {
      cleaned = cleaned.substring(headerIndex);
    }
    
    const validActions = ['navigate', 'click', 'fill', 'screenshot', 'wait'];
    const lines = cleaned.split('\n');
    const filteredLines = [];
    
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      
      const firstWord = line.split(',')[0].toLowerCase().trim();
      if (firstWord === 'action' || validActions.includes(firstWord)) {
        filteredLines.push(line);
      }
    }
    
    return filteredLines.join('\n');
  } catch (error) {
    throw new Error(`Failed to convert test case ${testCase.id} to CSV: ${error.message}`);
  }
}


/**
 * Parse converted CSV into step records
 * @param {string} csvString - CSV with Action,Selector,Value header
 * @returns {Array<Object>} Parsed step records
 */
function parseStepCSV(csvString) {
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
    throw new Error(`Failed to parse step CSV: ${error.message}`);
  }
}


/**
 * Execute a single Playwright action
 */
async function executeAction(page, action, selector, value) {
  let interactionResult = null;
  switch (action) {
    case 'navigate': {
      const navUrl = [value, selector].find(
        v => v && v.trim().length > 0 && /^https?:\/\//i.test(v.trim())
      );
      if (!navUrl) throw new Error(`Navigate action has no valid URL. Selector: "${selector}", Value: "${value}"`);
      await page.goto(navUrl.trim(), {
        waitUntil: 'domcontentloaded',
        timeout: ACTION_TIMEOUT_MS
      });
      await page.waitForTimeout(1000);
      try { await dismissCommonPopups(page); } catch (_) {}
      await page.waitForTimeout(500);
      break;
    }

    case 'click':
      if (!selector) throw new Error('Click action requires a Selector');
      interactionResult = await executeInteraction(page, 'click', selector, '', ACTION_TIMEOUT_MS);
      if (interactionResult.status === 'failed') throw new Error(interactionResult.error);
      await page.waitForTimeout(1500);
      break;

    case 'fill':
      if (!selector) throw new Error('Fill action requires a Selector');
      if (!value) throw new Error('Fill action requires a Value');
      interactionResult = await executeInteraction(page, 'fill', selector, value, ACTION_TIMEOUT_MS);
      if (interactionResult.status === 'failed') throw new Error(interactionResult.error);
      break;

    case 'screenshot':
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


/**
 * Execute a single action with retry logic
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
        await page.waitForTimeout(RETRY_WAIT_MS);
      }
    }
  }

  // All retries exhausted
  const screenshot = await captureScreenshot(page);

  let diagnostics = null;
  try {
    diagnostics = await runFailureDiagnostics({
      page,
      action,
      selector,
      value,
      errorMsg: lastError?.message || 'Unknown error',
      model,
      ollamaUrl
    });
  } catch (_) { /* diagnostics are best-effort */ }

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
 * Run a complete test suite from a high-level CSV
 * @param {Object} options - Suite options
 * @param {string} options.url - Target URL
 * @param {Array} options.cookies - Cookie objects to inject
 * @param {string} options.csvContent - Raw suite CSV content
 * @param {string} options.model - Ollama model name
 * @param {string} options.ollamaUrl - Ollama base URL
 * @param {string} options.runId - Unique run ID
 * @param {Function} options.onProgress - Progress callback
 * @param {AbortSignal} options.signal - Abort signal
 * @param {string} options.browserName - Browser to use
 * @param {string} options.deviceProfile - Device profile
 * @returns {Object} Suite results
 */
export async function runTestSuite(options) {
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
  const csvString = Buffer.isBuffer(csvContent) ? csvContent.toString('utf-8') : csvContent;
  
  // Parse suite CSV
  onProgress({ type: 'status', message: '📋 Parsing test suite CSV...' });
  const testCases = parseSuiteCSV(csvString);
  
  if (testCases.length === 0) {
    throw new Error('No valid test cases found in the CSV file');
  }
  
  onProgress({ type: 'info', message: `Found ${testCases.length} test cases in suite` });
  onProgress({ type: 'suite-info', totalCases: testCases.length, cases: testCases.map(tc => ({ id: tc.id, title: tc.title, module: tc.module })) });

  const suiteResults = [];
  let passedCases = 0;
  let failedCases = 0;

  for (let tcIndex = 0; tcIndex < testCases.length; tcIndex++) {
    if (signal?.aborted) {
      throw new Error('Test run cancelled by user');
    }

    const testCase = testCases[tcIndex];
    const tcStart = Date.now();
    
    onProgress({ 
      type: 'suite-case-start', 
      caseIndex: tcIndex, 
      totalCases: testCases.length,
      caseId: testCase.id,
      caseTitle: testCase.title,
      caseModule: testCase.module,
      message: `▶ [${tcIndex + 1}/${testCases.length}] ${testCase.id}: ${testCase.title}`
    });

    let browser = null;
    let context = null;
    let page = null;
    const steps = [];
    const consoleErrors = [];
    let caseStatus = 'passed';
    let caseError = null;
    let convertedCSV = null;

    try {
      // Step 1: Convert test case to Playwright CSV using Ollama
      onProgress({ type: 'status', message: `🤖 [${testCase.id}] Converting test steps using AI...` });
      
      try {
        convertedCSV = await convertTestCaseToCSV(testCase, model, ollamaUrl, url, signal);
        onProgress({ type: 'info', message: `[${testCase.id}] AI generated ${convertedCSV.split('\n').length - 1} executable steps` });
      } catch (convErr) {
        throw new Error(`AI conversion failed: ${convErr.message}`);
      }

      // Step 2: Parse the converted CSV into step records
      const stepRecords = parseStepCSV(convertedCSV);
      if (stepRecords.length === 0) {
        throw new Error('AI conversion produced no executable steps');
      }

      // Step 3: Launch isolated browser
      onProgress({ type: 'status', message: `🌐 [${testCase.id}] Launching isolated browser session...` });
      
      const launchOptions = getLaunchOptions(browserName, 300);
      browser = browserName === 'firefox'
        ? await firefox.launch(launchOptions)
        : await chromium.launch(launchOptions);

      const contextOptions = {
        viewport: { width: 1280, height: 720 }
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

      // Inject cookies if provided
      if (cookies.length > 0) {
        await context.addCookies(cookies);
      }

      page = await context.newPage();

      // Capture console errors
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

      // Step 4: Execute each step
      for (let i = 0; i < stepRecords.length; i++) {
        if (signal?.aborted) {
          throw new Error('Test run cancelled by user');
        }

        const record = stepRecords[i];
        const action = record.Action?.toLowerCase().trim();
        const selector = record.Selector?.trim() || '';
        const value = record.Value?.trim() || '';
        const stepName = `${action}${selector ? ` → ${selector}` : ''}${value ? ` = "${value}"` : ''}`;

        const validActions = ['navigate', 'click', 'fill', 'screenshot', 'wait'];
        if (!validActions.includes(action)) {
          console.warn(`[Suite] Skipping invalid action "${action}" in ${testCase.id}`);
          continue;
        }

        onProgress({
          type: 'step',
          step: i + 1,
          total: stepRecords.length,
          message: `[${testCase.id}] Step ${i + 1}/${stepRecords.length}: ${stepName}`
        });

        const stepResult = await executeActionWithRetry(page, action, selector, value, stepName, signal, model, ollamaUrl);
        steps.push(stepResult);

        onProgress({
          type: 'step-result',
          step: i + 1,
          total: stepRecords.length,
          status: stepResult.status,
          message: stepResult.status === 'passed'
            ? `✅ [${testCase.id}] Step ${i + 1} passed`
            : `❌ [${testCase.id}] Step ${i + 1} failed: ${stepResult.error}`
        });

        if (stepResult.status === 'failed') {
          caseStatus = 'failed';
          caseError = stepResult.error;
          onProgress({ type: 'info', message: `[${testCase.id}] Step failed — stopping this test case, moving to next.` });
          break;
        }
      }

    } catch (error) {
      caseStatus = 'failed';
      caseError = error.message;
      
      // Add a system error step for the report
      steps.push({
        name: `Fatal Error in ${testCase.id}`,
        action: 'system',
        selector: '',
        value: '',
        status: 'failed',
        duration: 0,
        error: error.message,
        screenshot: page ? await captureScreenshot(page) : null,
        reason: ''
      });

      onProgress({ type: 'info', message: `❌ [${testCase.id}] Failed: ${error.message}` });
    } finally {
      // Clean up browser for this test case
      if (page) {
        try { await page.close(); } catch (_) {}
      }
      if (context) {
        try { await context.close(); } catch (_) {}
      }
      if (browser) {
        try { await browser.close(); } catch (_) {}
      }
    }

    const tcDuration = Date.now() - tcStart;

    if (caseStatus === 'passed') passedCases++;
    else failedCases++;

    const caseResult = {
      testCaseId: testCase.id,
      title: testCase.title,
      module: testCase.module,
      priority: testCase.priority,
      type: testCase.type,
      preconditions: testCase.preconditions,
      testData: testCase.testData,
      originalSteps: testCase.steps,
      expectedResult: testCase.expectedResult,
      convertedCSV: convertedCSV,
      status: caseStatus,
      error: caseError,
      duration: tcDuration,
      steps,
      consoleErrors
    };

    suiteResults.push(caseResult);

    onProgress({
      type: 'suite-case-end',
      caseIndex: tcIndex,
      totalCases: testCases.length,
      caseId: testCase.id,
      caseTitle: testCase.title,
      status: caseStatus,
      duration: tcDuration,
      message: caseStatus === 'passed'
        ? `✅ [${tcIndex + 1}/${testCases.length}] ${testCase.id} — PASSED (${(tcDuration / 1000).toFixed(1)}s)`
        : `❌ [${tcIndex + 1}/${testCases.length}] ${testCase.id} — FAILED: ${caseError}`
    });

    onProgress({
      type: 'suite-progress',
      completed: tcIndex + 1,
      total: testCases.length,
      passed: passedCases,
      failed: failedCases
    });
  }

  const endTime = new Date();
  
  return {
    testName: 'Test Suite Execution',
    url,
    mode: 'suite',
    model,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    suiteResults,
    totalCases: testCases.length,
    passedCases,
    failedCases,
    consoleErrors: [],
    cookies,
    // Provide flat steps array for compatibility with existing report metrics
    steps: suiteResults.flatMap(tc => tc.steps)
  };
}
