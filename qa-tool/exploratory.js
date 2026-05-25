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

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Configuration */
const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5-coder:7b';
const MAX_EXPLORATION_ROUNDS = 8;
const MAX_ACTIONS_PER_ROUND = 6;
const ACTION_TIMEOUT_MS = 30000;
const OLLAMA_TIMEOUT_MS = 120000;

/** System prompt for the AI explorer */
const SYSTEM_PROMPT = `You are a QA automation expert. Explore this website systematically:
- Click all major navigation links
- Fill any visible forms with realistic test data
- Validate that buttons and links work
- Take screenshots of each page section
- Identify broken elements or console errors
- Document any bugs found

Generate a JSON array of Playwright actions. Each action must be an object with these fields:
- "action": one of "navigate", "click", "fill", "screenshot", "wait", "scroll"
- "selector": CSS selector for the target element (for click, fill, scroll)
- "value": value to input (for fill), URL (for navigate), milliseconds (for wait), or filename (for screenshot)
- "reason": brief explanation of why this action is the next logical step

IMPORTANT RULES:
1. Return ONLY a valid JSON array, no additional text
2. Use realistic test data for form fills (e.g., "John Doe", "test@example.com", "+1234567890")
3. Prefer CSS selectors that are stable (IDs, data-testid, aria-label)
4. Include screenshot actions between major navigation changes
5. Don't repeat the same action twice
6. When exploration is complete, return: [{"action": "done", "reason": "Exploration complete"}]

Example response:
[
  {"action": "screenshot", "value": "initial-state.png", "reason": "Capture initial page state"},
  {"action": "click", "selector": "nav a:first-child", "reason": "Click first navigation link"},
  {"action": "screenshot", "value": "after-nav.png", "reason": "Capture state after navigation"},
  {"action": "fill", "selector": "input[type=email]", "value": "test@example.com", "reason": "Fill email field with test data"}
]`;


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
    onProgress = () => {}
  } = options;

  const startTime = new Date();
  const steps = [];
  const consoleErrors = [];
  let browser = null;
  let context = null;
  let page = null;

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
    onProgress({ type: 'status', message: 'Launching browser...' });
    browser = await chromium.launch({
      headless: false,
      slowMo: 400
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

    // --- Navigate to URL ---
    onProgress({ type: 'step', step: 0, message: `Navigating to ${url}` });
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
        reason: 'Initial navigation to target URL'
      });
      onProgress({ type: 'step-result', status: 'passed', message: '✅ Initial navigation successful' });
    } catch (err) {
      steps.push({
        name: `Navigate to ${url}`,
        action: 'navigate',
        selector: '',
        value: url,
        status: 'failed',
        duration: Date.now() - navStart,
        error: err.message,
        screenshot: null,
        reason: 'Initial navigation failed'
      });
      throw new Error(`Failed to navigate to ${url}: ${err.message}`);
    }

    // --- Handle common popups (cookie banners, etc.) ---
    onProgress({ type: 'info', message: 'Checking for popups...' });
    await handleCommonPopups(page);

    // --- Exploration Loop ---
    let explorationComplete = false;
    let totalActionsExecuted = 0;

    for (let round = 1; round <= MAX_EXPLORATION_ROUNDS && !explorationComplete; round++) {
      onProgress({
        type: 'status',
        message: `🤖 Exploration round ${round}/${MAX_EXPLORATION_ROUNDS} — Asking AI for next actions...`
      });

      // Extract current page context
      const pageContext = await extractPageContext(page);

      // Query Ollama for next actions
      let actions;
      try {
        actions = await queryOllamaForActions(ollamaUrl, model, url, pageContext, round);
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
        const actionDef = actionsToExecute[i];
        totalActionsExecuted++;
        const stepName = `[R${round}] ${actionDef.action}${actionDef.selector ? ` → ${actionDef.selector}` : ''}`;

        onProgress({
          type: 'step',
          step: totalActionsExecuted,
          message: `Step ${totalActionsExecuted}: ${stepName} — ${actionDef.reason || ''}`
        });

        const stepResult = await executeExploratoryAction(page, actionDef, stepName);
        steps.push(stepResult);

        onProgress({
          type: 'step-result',
          step: totalActionsExecuted,
          status: stepResult.status,
          message: stepResult.status === 'passed'
            ? `✅ ${stepName}`
            : `❌ ${stepName}: ${stepResult.error}`
        });

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
    testName: 'AI Exploratory Test',
    url,
    mode: 'exploratory',
    model,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    steps,
    consoleErrors,
    cookies
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
 * Query Ollama for the next set of exploration actions
 */
async function queryOllamaForActions(ollamaUrl, model, targetUrl, pageContext, round) {
  const contextStr = `
Current Page State (Round ${round}):
- Title: ${pageContext.title}
- URL: ${pageContext.url}
- Headings: ${pageContext.headings.map(h => `${h.tag}: "${h.text}"`).join(', ') || 'none'}
- Visible Links (${pageContext.links.length}): ${pageContext.links.slice(0, 8).map(l => `"${l.text}" (${l.selector})`).join(', ') || 'none'}
- Visible Buttons (${pageContext.buttons.length}): ${pageContext.buttons.slice(0, 6).map(b => `"${b.text}" (${b.selector})`).join(', ') || 'none'}
- Input Fields (${pageContext.inputs.length}): ${pageContext.inputs.slice(0, 6).map(i => `${i.type} name="${i.name}" placeholder="${i.placeholder}" (${i.selector})`).join(', ') || 'none'}
- Forms: ${pageContext.forms.length} found
`;

  const prompt = `${SYSTEM_PROMPT}

${contextStr}

Target URL: ${targetUrl}
Round: ${round} of ${MAX_EXPLORATION_ROUNDS}

Based on the current page state, generate the next ${MAX_ACTIONS_PER_ROUND} Playwright actions to continue exploring this website. Return ONLY a JSON array.`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: 'json'
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

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
 * Extract JSON array of actions from Ollama response
 */
function extractActionsArray(response) {
  // Try direct parse
  try {
    const parsed = JSON.parse(response.trim());
    if (Array.isArray(parsed)) return parsed;
    // If it's an object with an array property, try common keys
    if (parsed.actions && Array.isArray(parsed.actions)) return parsed.actions;
    if (parsed.steps && Array.isArray(parsed.steps)) return parsed.steps;
    // Single action object — wrap in array
    if (parsed.action) return [parsed];
  } catch (e) {
    // Try to find JSON in markdown code blocks
    const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        const parsed = JSON.parse(codeBlockMatch[1].trim());
        if (Array.isArray(parsed)) return parsed;
        if (parsed.action) return [parsed];
      } catch (_) { /* continue */ }
    }

    // Try to find array pattern
    const arrayStart = response.indexOf('[');
    const arrayEnd = response.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      try {
        return JSON.parse(response.substring(arrayStart, arrayEnd + 1));
      } catch (_) { /* continue */ }
    }

    // Try to find object pattern
    const objStart = response.indexOf('{');
    const objEnd = response.lastIndexOf('}');
    if (objStart !== -1 && objEnd > objStart) {
      try {
        const parsed = JSON.parse(response.substring(objStart, objEnd + 1));
        if (parsed.action) return [parsed];
      } catch (_) { /* continue */ }
    }
  }

  throw new Error(`Unable to parse actions from Ollama response: ${response.substring(0, 200)}...`);
}


/**
 * Execute a single exploratory action with error handling
 */
async function executeExploratoryAction(page, actionDef, stepName) {
  const stepStart = Date.now();
  const { action, selector, value, reason = '' } = actionDef;

  try {
    switch (action) {
      case 'navigate':
        await page.goto(value || selector, {
          waitUntil: 'domcontentloaded',
          timeout: ACTION_TIMEOUT_MS
        });
        break;

      case 'click':
        if (!selector) throw new Error('Click requires a selector');
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.locator(selector).first().click();
        await page.waitForTimeout(500);
        break;

      case 'fill':
        if (!selector) throw new Error('Fill requires a selector');
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.locator(selector).first().clear();
        await page.locator(selector).first().fill(value || 'test');
        break;

      case 'screenshot':
        await page.waitForTimeout(300);
        break;

      case 'wait':
        await page.waitForTimeout(parseInt(value) || 1000);
        break;

      case 'scroll':
        if (selector) {
          await page.locator(selector).first().scrollIntoViewIfNeeded();
        } else {
          await page.evaluate(() => window.scrollBy(0, 400));
        }
        await page.waitForTimeout(300);
        break;

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    const screenshot = await captureScreenshot(page);
    return {
      name: stepName,
      action,
      selector: selector || '',
      value: value || '',
      status: 'passed',
      duration: Date.now() - stepStart,
      error: null,
      screenshot,
      reason
    };

  } catch (error) {
    const screenshot = await captureScreenshot(page);
    return {
      name: stepName,
      action,
      selector: selector || '',
      value: value || '',
      status: 'failed',
      duration: Date.now() - stepStart,
      error: error.message,
      screenshot,
      reason
    };
  }
}


/**
 * Handle common popups like cookie banners
 */
async function handleCommonPopups(page) {
  const acceptSelectors = [
    'button:has-text("Accept")',
    'button:has-text("Accept All")',
    'button:has-text("Akzeptieren")',
    'button:has-text("Agree")',
    'button:has-text("OK")',
    'button:has-text("Got it")',
    '[data-testid="cookie-accept"]',
    '#onetrust-accept-btn-handler',
    '.cookie-accept',
  ];

  for (const selector of acceptSelectors) {
    try {
      const element = await page.$(selector);
      if (element) {
        const isVisible = await element.isVisible();
        if (isVisible) {
          await element.click();
          console.log(`✅ Dismissed popup with: ${selector}`);
          await page.waitForTimeout(500);
          return;
        }
      }
    } catch (_) {
      // Continue to next selector
    }
  }
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
