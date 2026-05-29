/**
 * exploratory.js — AI-Powered Exploratory Testing with Ollama + Playwright
 * 
 * Uses local Ollama LLM to automatically explore a website:
 * 1. Validates Ollama is running
 * 2. Navigates to target URL
 * 3. Sends page context to Ollama with system prompt
 * 4. Ollama returns JSON array of Playwright actions
 * 5. Executes actions sequentially with error handling
 * 6. Loops: sends updated page state back for next exploration batch
 * 7. Stops after max iterations or when LLM signals completion
 */

import { chromium, firefox, devices } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { executeInteraction, dismissCommonPopups, runFailureDiagnostics } from './interaction-helper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Configuration */
const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5-coder:7b';
const MAX_EXPLORATION_ROUNDS = 8;
const MAX_ACTIONS_PER_ROUND = 5;
const ACTION_TIMEOUT_MS = 5000;
const OLLAMA_TIMEOUT_MS = 120000;
const MAX_RETRIES = 1;
const RETRY_WAIT_MS = 1000;
/** Max executed steps to include in history injected into each prompt (keeps tokens manageable) */
const MAX_HISTORY_IN_PROMPT = 12;

//** System prompt for Bug Hunting Mode */
const BUG_HUNTING_SYSTEM_PROMPT = `You are a QA automation expert. Your job is to find bugs, crashes, or unhandled exceptions.

Generate a JSON array of Playwright actions. Each action must be an object:
- "action": one of "navigate", "click", "fill", "screenshot", "wait", "scroll"
- "selector": CSS selector for the element (required for click, fill, scroll)
- "value": text to type (fill), URL (navigate), or milliseconds (wait)
- "reason": one short sentence explaining this action

RULES (follow strictly):
1. Return ONLY the raw JSON array. No markdown, no explanation, no code fences.
2. Do NOT repeat any action that appears in the "Already executed" history.
3. Use realistic test data: "John Doe", "test@example.com", "Pass@1234"
4. Prefer stable selectors: IDs (#id), name attributes ([name="x"]), aria-label, data-testid.
5. Generate at most 5 actions.
6. Actively try to break the site: test boundaries, submit empty/invalid forms, click complex elements.
7. Check for console errors or broken navigation.
8. If nothing new can be tested, return exactly: [{"action":"done","reason":"All elements tested"}]

Example:
[{"action":"screenshot","reason":"Capture initial state"},{"action":"click","selector":"#login-btn","reason":"Open login form"}]`;

/** System prompt for Business Auto-Doc Mode */
const DOCUMENTATION_SYSTEM_PROMPT = `You are a business analyst and QA mapping agent. Your job is to explore a website to catalog its features, components, and user journeys.

Generate a JSON array of Playwright actions. Each action must be an object:
- "action": one of "navigate", "click", "fill", "screenshot", "wait", "scroll"
- "selector": CSS selector for the element (required for click, fill, scroll)
- "value": text to type (fill), URL (navigate), or milliseconds (wait)
- "reason": one short sentence explaining the business/functional intent of this action (e.g. "Access the checkout form to start payment process")

RULES (follow strictly):
1. Return ONLY the raw JSON array. No markdown, no explanation, no code fences.
2. Do NOT repeat any action that appears in the "Already executed" history.
3. Prefer stable selectors: IDs (#id), name attributes ([name="x"]), aria-label, data-testid.
4. Generate at most 5 actions.
5. Focus on business coverage: visit unique routes, scan major forms and features, and catalog key page elements.
6. Write the "reason" field in professional business/functional terms, describing what the user intends to achieve.
7. If all key business flows and pages have been visited, return exactly: [{"action":"done","reason":"Business crawl complete"}]

Example:
[{"action":"screenshot","reason":"Verify page layout and promotional banners"},{"action":"click","selector":"a.nav-shop","reason":"Access product shop catalog directory"}]`;


/**
 * Validate that Ollama is running and the model is available
 * @param {string} baseUrl - Ollama base URL
 * @param {string} model - Model name to check
 * @returns {Object} { available: boolean, models: string[], error: string }
 */
export async function checkOllamaStatus(baseUrl = OLLAMA_BASE_URL, model = DEFAULT_MODEL) {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      return { available: false, models: [], error: `Ollama returned ${response.status}` };
    }

    const data = await response.json();
    const models = (data.models || []).map(m => m.name);
    const modelAvailable = models.some(m => m.startsWith(model.split(':')[0]));

    return {
      available: true,
      models,
      modelAvailable,
      error: modelAvailable ? null : `Model "${model}" not found. Available: ${models.join(', ')}`
    };
  } catch (error) {
    return {
      available: false,
      models: [],
      error: `Cannot connect to Ollama at ${baseUrl}: ${error.message}`
    };
  }
}


/**
 * Run AI-powered exploratory test
 * @param {Object} options - Test options
 * @param {string} options.url - Target URL to explore
 * @param {Array} options.cookies - Cookies to inject
 * @param {string} options.model - Ollama model name
 * @param {string} options.ollamaUrl - Ollama base URL
 * @param {Function} options.onProgress - Progress callback
 * @returns {Object} Test results
 */
export async function runExploratoryTest(options) {
  const {
    url,
    cookies = [],
    model = DEFAULT_MODEL,
    ollamaUrl = OLLAMA_BASE_URL,
    runId,
    onProgress = () => {},
    signal,
    browserName = 'chrome',
    exploratoryType = 'bug-hunting',
    deviceProfile = 'desktop'
  } = options;

  const startTime = new Date();
  const steps = [];
  const consoleErrors = [];
  let browser = null;
  let context = null;
  let page = null;
  let videoDir = null;

  // Crawl storage for site documentation mode
  const sitemap = new Map();
  const locators = new Map();
  const transitions = [];

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
    // --- Validate Ollama ---
    onProgress({ type: 'status', message: 'Checking Ollama connection...' });
    const ollamaStatus = await checkOllamaStatus(ollamaUrl, model);

    if (!ollamaStatus.available) {
      throw new Error(`Ollama is not running. ${ollamaStatus.error}. Please start Ollama and try again.`);
    }

    onProgress({ type: 'info', message: `Ollama connected. Using model: ${model}` });

    if (!ollamaStatus.modelAvailable) {
      onProgress({ type: 'warning', message: ollamaStatus.error });
    }

    // --- Launch Browser ---
    onProgress({ type: 'status', message: `Launching browser ${browserName}...` });
    if (browserName === 'firefox') {
      browser = await firefox.launch({
        headless: false,
        slowMo: 400
      });
    } else if (browserName === 'edge') {
      browser = await chromium.launch({
        headless: false,
        slowMo: 400,
        channel: 'msedge'
      });
    } else {
      browser = await chromium.launch({
        headless: false,
        slowMo: 400
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

    // --- Navigate to URL ---
    onProgress({ type: 'step', step: 0, message: `Navigating to ${url}` });
    const navStart = Date.now();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
      const screenshot = await captureScreenshot(page);
      steps.push({
        name: `Navigate to ${url}`,
        action: 'navigate',
        selector: '',
        value: url,
        status: 'passed',
        duration: Date.now() - navStart,
        error: null,
        screenshot,
        reason: 'Initial navigation to target URL'
      });
      onProgress({ type: 'step-result', status: 'passed', message: '✅ Initial navigation successful' });

      // Catalog initial page state for documentation mode
      if (exploratoryType === 'documentation') {
        const pageContext = await extractPageContext(page);
        const currentUrl = page.url();
        const currentTitle = pageContext.title || 'Home';
        let pathname = '/';
        try {
          pathname = new URL(currentUrl).pathname;
        } catch (_) {}
        sitemap.set(pathname, { title: currentTitle, headings: pageContext.headings || [] });
        catalogElements(pathname, pageContext, locators);
        transitions.push({
          from: 'Start',
          to: pathname,
          action: `Navigate to ${url}`,
          reason: 'Initial page load',
          screenshot
        });
      }
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
        screenshot: null,
        reason: 'Initial navigation failed',
        diagnostics
      });
      throw new Error(`Failed to navigate to ${url}: ${err.message}`);
    }

    // --- Handle common popups (cookie banners, etc.) ---
    onProgress({ type: 'info', message: 'Checking for popups...' });
    try {
      await dismissCommonPopups(page);
    } catch (popupErr) {
      console.warn(`[Exploratory Test] Failed to run dismissCommonPopups: ${popupErr.message}`);
    }

    // --- Exploration Loop ---
    let explorationComplete = false;
    let totalActionsExecuted = 0;
    /** Compact history of already-executed actions — injected into every prompt */
    const executedHistory = [];

    for (let round = 1; round <= MAX_EXPLORATION_ROUNDS && !explorationComplete; round++) {
      if (signal?.aborted) {
        throw new Error('Test run cancelled by user');
      }
      onProgress({
        type: 'status',
        message: `🤖 Exploration round ${round}/${MAX_EXPLORATION_ROUNDS} — Asking AI for next actions...`
      });

      // Extract current page context
      const pageContext = await extractPageContext(page);

      // Query Ollama for next actions, passing executed history to prevent repetition/hallucination
      let actions;
      try {
        actions = await queryOllamaForActions(ollamaUrl, model, url, pageContext, round, executedHistory, signal, exploratoryType);
      } catch (err) {
        onProgress({ type: 'error', message: `Ollama query failed: ${err.message}` });
        steps.push({
          name: `AI Query Round ${round}`,
          action: 'ai-query',
          selector: '',
          value: '',
          status: 'failed',
          duration: 0,
          error: err.message,
          screenshot: null,
          reason: 'Failed to get actions from Ollama'
        });
        continue;
      }

      if (!actions || actions.length === 0) {
        onProgress({ type: 'info', message: 'No more actions suggested by AI' });
        break;
      }

      // Check for "done" signal
      if (actions.some(a => a.action === 'done')) {
        onProgress({ type: 'info', message: '🏁 AI signaled exploration complete' });
        explorationComplete = true;
        break;
      }

      // Execute each action
      const actionsToExecute = actions.slice(0, MAX_ACTIONS_PER_ROUND);
      for (let i = 0; i < actionsToExecute.length; i++) {
        if (signal?.aborted) {
          throw new Error('Test run cancelled by user');
        }
        const actionDef = actionsToExecute[i];
        totalActionsExecuted++;
        const stepName = `[R${round}] ${actionDef.action}${actionDef.selector ? ` → ${actionDef.selector}` : ''}`;

        onProgress({
          type: 'step',
          step: totalActionsExecuted,
          message: `Step ${totalActionsExecuted}: ${stepName} — ${actionDef.reason || ''}`
        });

        const fromUrl = page.url();
        let fromPathname = '/';
        try { fromPathname = new URL(fromUrl).pathname; } catch (_) {}

        const stepResult = await executeExploratoryAction(page, actionDef, stepName, url, signal, model, ollamaUrl);
        steps.push(stepResult);

        // Record this action in history so future rounds know it was attempted
        executedHistory.push({
          action: actionDef.action,
          selector: actionDef.selector || '',
          value: actionDef.value || '',
          status: stepResult.status
        });

        // Catalog the new page if successfully navigated/interacted
        if (exploratoryType === 'documentation' && stepResult.status === 'passed') {
          const postPageContext = await extractPageContext(page);
          const toUrl = page.url();
          const toTitle = postPageContext.title || 'Page';
          let toPathname = '/';
          try { toPathname = new URL(toUrl).pathname; } catch (_) {}

          sitemap.set(toPathname, { title: toTitle, headings: postPageContext.headings || [] });
          catalogElements(toPathname, postPageContext, locators);

          transitions.push({
            from: fromPathname,
            to: toPathname,
            action: stepName,
            reason: actionDef.reason || '',
            screenshot: stepResult.screenshot
          });
        }

        onProgress({
          type: 'step-result',
          step: totalActionsExecuted,
          status: stepResult.status,
          message: stepResult.status === 'passed'
            ? `✅ ${stepName}`
            : `❌ ${stepName}: ${stepResult.error}`
        });

        if (stepResult.status === 'failed') {
          onProgress({
            type: 'info',
            message: `Step ${totalActionsExecuted} failed. Halting further action execution and generating report.`
          });
          explorationComplete = true;
          break;
        }

        // Brief pause between actions
        await page.waitForTimeout(300);
      }
    }

    if (!explorationComplete) {
      onProgress({ type: 'info', message: `Exploration stopped after ${MAX_EXPLORATION_ROUNDS} rounds` });
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
    testName: 'AI Exploratory Test',
    url,
    mode: 'exploratory',
    exploratoryType,
    model,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    steps,
    consoleErrors,
    cookies,
    crawlResults: exploratoryType === 'documentation' ? {
      sitemap: Array.from(sitemap.entries()),
      locators: Array.from(locators.values()),
      transitions: transitions
    } : null
  };

  onProgress({ type: 'complete', message: 'Exploratory test complete', results });
  return results;
}


/**
 * Extract page context for the AI prompt
 */
async function extractPageContext(page) {
  try {
    const context = await page.evaluate(() => {
      const result = {
        title: document.title,
        url: window.location.href,
        headings: [],
        links: [],
        buttons: [],
        inputs: [],
        forms: []
      };

      // Headings
      document.querySelectorAll('h1, h2, h3').forEach(h => {
        const text = h.textContent?.trim().substring(0, 80);
        if (text) result.headings.push({ tag: h.tagName, text });
      });

      // Visible links (top 15)
      let linkCount = 0;
      document.querySelectorAll('a[href]').forEach(a => {
        if (linkCount >= 15) return;
        const rect = a.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          result.links.push({
            text: a.textContent?.trim().substring(0, 50) || '',
            href: a.href,
            selector: a.id ? `#${a.id}` : (a.className ? `a.${a.className.split(' ')[0]}` : `a[href="${a.getAttribute('href')}"]`)
          });
          linkCount++;
        }
      });

      // Visible buttons (top 10)
      let btnCount = 0;
      document.querySelectorAll('button, [role="button"], input[type="submit"]').forEach(btn => {
        if (btnCount >= 10) return;
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          result.buttons.push({
            text: btn.textContent?.trim().substring(0, 50) || btn.value || '',
            selector: btn.id ? `#${btn.id}` : (btn.className ? `button.${btn.className.split(' ')[0]}` : 'button')
          });
          btnCount++;
        }
      });

      // Visible inputs (top 10)
      let inputCount = 0;
      document.querySelectorAll('input:not([type="hidden"]), textarea, select').forEach(input => {
        if (inputCount >= 10) return;
        const rect = input.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          result.inputs.push({
            type: input.type || input.tagName.toLowerCase(),
            name: input.name || '',
            placeholder: input.placeholder || '',
            id: input.id || '',
            selector: input.id ? `#${input.id}` : (input.name ? `[name="${input.name}"]` : `input[type="${input.type}"]`)
          });
          inputCount++;
        }
      });

      // Forms
      document.querySelectorAll('form').forEach(form => {
        result.forms.push({
          action: form.action || '',
          method: form.method || 'GET',
          id: form.id || '',
          fieldCount: form.elements.length
        });
      });

      return result;
    });

    return context;
  } catch (error) {
    return { title: 'Unknown', url: '', headings: [], links: [], buttons: [], inputs: [], forms: [] };
  }
}


/**
 * Catalog inputs and buttons into the locators map for Site Documentation Mode
 */
function catalogElements(pathname, pageContext, locators) {
  if (pageContext.inputs) {
    pageContext.inputs.forEach(input => {
      const key = `${pathname}::${input.selector}`;
      if (!locators.has(key)) {
        locators.set(key, {
          page: pathname,
          type: input.type || 'input',
          name: input.name || '',
          placeholder: input.placeholder || '',
          selector: input.selector
        });
      }
    });
  }
  if (pageContext.buttons) {
    pageContext.buttons.forEach(button => {
      const key = `${pathname}::${button.selector}`;
      if (!locators.has(key)) {
        locators.set(key, {
          page: pathname,
          type: 'button',
          name: button.text || '',
          placeholder: '',
          selector: button.selector
        });
      }
    });
  }
}


/**
 * Query Ollama for the next set of exploration actions
 * @param {string[]} executedHistory - Summary of already-executed actions to prevent repetition
 */
async function queryOllamaForActions(ollamaUrl, model, targetUrl, pageContext, round, executedHistory = [], signal, exploratoryType = 'bug-hunting') {
  // Build a compact page context string — keep it short for small local models
  const contextStr = [
    `Page: "${pageContext.title}" | URL: ${pageContext.url}`,
    pageContext.headings.length
      ? `Headings: ${pageContext.headings.slice(0, 4).map(h => `"${h.text}"`).join(', ')}`
      : '',
    pageContext.inputs.length
      ? `Inputs: ${pageContext.inputs.slice(0, 5).map(i => `${i.type}(${i.selector})`).join(', ')}`
      : '',
    pageContext.buttons.length
      ? `Buttons: ${pageContext.buttons.slice(0, 5).map(b => `"${b.text}"(${b.selector})`).join(', ')}`
      : '',
    pageContext.links.length
      ? `Links: ${pageContext.links.slice(0, 6).map(l => `"${l.text}"(${l.selector})`).join(', ')}`
      : ''
  ].filter(Boolean).join('\n');

  // Build the history block — crucial for preventing hallucination in later rounds
  const historyBlock = executedHistory.length > 0
    ? `\nAlready executed (DO NOT repeat these):\n${executedHistory
        .slice(-MAX_HISTORY_IN_PROMPT)
        .map((h, idx) => `  ${idx + 1}. ${h.action}${h.selector ? ' ' + h.selector : ''}${h.value ? ' = "' + h.value + '"' : ''} [${h.status}]`)
        .join('\n')}`
    : '';

  const systemPrompt = exploratoryType === 'documentation' ? DOCUMENTATION_SYSTEM_PROMPT : BUG_HUNTING_SYSTEM_PROMPT;

  const prompt = `${systemPrompt}${historyBlock}

Current page state (Round ${round}/${MAX_EXPLORATION_ROUNDS}):
${contextStr}

Target URL: ${targetUrl}

Generate the next actions. Return ONLY a valid JSON array:`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

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
        // NOTE: Do NOT use format:'json' here — it forces constrained generation that causes
        // small local models to fabricate syntactically valid but semantically wrong arrays.
        // We handle JSON extraction robustly in extractActionsArray() instead.
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const rawResponse = data.response || '';

    // Try to parse as JSON array
    return extractActionsArray(rawResponse);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Ollama request timed out after ${OLLAMA_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  }
}


/**
 * Extract JSON array of actions from Ollama response.
 * Handles common local-LLM output quirks: markdown fences, trailing text,
 * single objects, wrapped arrays, and minor JSON syntax errors.
 */
function extractActionsArray(response) {
  let cleaned = response.trim();

  // Strip opening/closing code fences if present, even if incomplete (e.g. truncated response)
  cleaned = cleaned.replace(/^```(json)?/i, '').trim();
  cleaned = cleaned.replace(/```$/, '').trim();

  // 2. Try direct parse on cleaned text
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return filterValidActions(parsed);
    if (parsed.actions && Array.isArray(parsed.actions)) return filterValidActions(parsed.actions);
    if (parsed.steps && Array.isArray(parsed.steps)) return filterValidActions(parsed.steps);
    if (parsed.action) return filterValidActions([parsed]);
  } catch (_) { /* fall through to extraction strategies */ }

  // 3. Extract first JSON array from the response (handles leading/trailing text)
  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      const parsed = JSON.parse(cleaned.substring(arrayStart, arrayEnd + 1));
      if (Array.isArray(parsed)) return filterValidActions(parsed);
    } catch (_) { /* fall through */ }
  }

  // 4. Extract first JSON object (single-action response from small models)
  const objStart = cleaned.indexOf('{');
  const objEnd = cleaned.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    try {
      const parsed = JSON.parse(cleaned.substring(objStart, objEnd + 1));
      if (parsed.action) return filterValidActions([parsed]);
    } catch (_) { /* fall through */ }
  }

  // 5. Last resort: attempt to repair truncated JSON by closing open brackets
  try {
    const repaired = repairTruncatedJson(cleaned);
    const parsed = JSON.parse(repaired);
    if (Array.isArray(parsed) && parsed.length > 0) return filterValidActions(parsed);
  } catch (_) { /* give up */ }

  throw new Error(`Unable to parse actions from Ollama response: ${text.substring(0, 300)}`);
}


/**
 * Filter out objects missing a valid 'action' field, preventing hallucinated garbage
 * from being passed to Playwright.
 */
const VALID_ACTIONS_SET = new Set(['navigate', 'click', 'fill', 'screenshot', 'wait', 'scroll', 'done']);
function filterValidActions(arr) {
  return arr.filter(item =>
    item && typeof item === 'object' && typeof item.action === 'string' &&
    VALID_ACTIONS_SET.has(item.action.toLowerCase())
  );
}


/**
 * Attempt to close an incomplete/truncated JSON array so it can be parsed.
 * Handles the common case where local LLMs cut off mid-generation.
 */
function repairTruncatedJson(text) {
  // Find the start of the array
  const start = text.indexOf('[');
  if (start === -1) return text;
  let fragment = text.substring(start);

  // Count open brackets/braces to find out what needs closing
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;

  for (const ch of fragment) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') openBraces++;
    else if (ch === '}') openBraces--;
    else if (ch === '[') openBrackets++;
    else if (ch === ']') openBrackets--;
  }

  // Close any open structures
  let closing = '';
  // Remove trailing comma before we close
  fragment = fragment.replace(/,\s*$/, '');
  for (let i = 0; i < openBraces; i++) closing += '}';
  for (let i = 0; i < openBrackets; i++) closing += ']';
  return fragment + closing;
}


/**
 * Execute a single exploratory action with error handling
 */
async function executeExploratoryAction(page, actionDef, stepName, targetUrl, signal, model, ollamaUrl) {
  const { action, selector, value, reason = '' } = actionDef;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) {
      throw new Error('Test run cancelled by user');
    }
    const stepStart = Date.now();

    try {
      let interactionResult = null;
      switch (action) {
        case 'navigate':
          let target = value || selector;
          if (!target) {
            target = targetUrl;
          } else {
            try {
              const base = page.url() || targetUrl;
              target = new URL(target, base).href;
            } catch (_) {
              // fallback
            }
          }
          await page.goto(target, {
            waitUntil: 'domcontentloaded',
            timeout: ACTION_TIMEOUT_MS
          });
          break;

        case 'click':
          if (!selector) throw new Error('Click requires a selector');
          interactionResult = await executeInteraction(page, 'click', selector, '', ACTION_TIMEOUT_MS);
          if (interactionResult.status === 'failed') throw new Error(interactionResult.error);
          await page.waitForTimeout(500);
          break;

        case 'fill':
          if (!selector) throw new Error('Fill requires a selector');
          interactionResult = await executeInteraction(page, 'fill', selector, value || 'test', ACTION_TIMEOUT_MS);
          if (interactionResult.status === 'failed') throw new Error(interactionResult.error);
          break;

        case 'screenshot':
          await page.waitForTimeout(300);
          break;

        case 'wait':
          await page.waitForTimeout(parseInt(value) || 1000);
          break;

        case 'scroll':
          interactionResult = await executeInteraction(page, 'scroll', selector, '', ACTION_TIMEOUT_MS);
          if (interactionResult.status === 'failed') throw new Error(interactionResult.error);
          await page.waitForTimeout(300);
          break;

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      if (signal?.aborted) {
        throw new Error('Test run cancelled by user');
      }

      const screenshot = await captureScreenshot(page);
      let finalReason = reason;
      if (interactionResult && interactionResult.healed) {
        finalReason = reason
          ? `${reason} (Self-healed: ${interactionResult.healMethod} -> ${interactionResult.resolvedSelector})`
          : `Self-healed: ${interactionResult.healMethod} -> ${interactionResult.resolvedSelector}`;
      }

      return {
        name: stepName,
        action,
        selector: selector || '',
        value: value || '',
        status: 'passed',
        duration: Date.now() - stepStart,
        error: null,
        screenshot,
        reason: attempt > 1 ? `${finalReason} (Passed on retry #${attempt})` : finalReason
      };

    } catch (error) {
      if (signal?.aborted) {
        throw new Error('Test run cancelled by user');
      }
      lastError = error;
      console.warn(`⚠️ Attempt ${attempt}/${MAX_RETRIES} failed for "${stepName}": ${error.message}`);

      if (attempt < MAX_RETRIES) {
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
    selector: selector || '',
    value: value || '',
    status: 'failed',
    duration: 0,
    error: lastError?.message || 'Unknown error',
    screenshot,
    reason: `${reason} (Failed after ${MAX_RETRIES} attempts)`,
    diagnostics
  };
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
