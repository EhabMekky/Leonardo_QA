/**
 * server.js — Main Express Server for QA Automation Tool
 * 
 * Endpoints:
 *   GET  /                    — Serves the frontend UI
 *   POST /run-test            — Starts a test run (multipart form)
 *   GET  /test-status/:id     — SSE stream for live test progress
 *   GET  /report/:id          — Serves generated HTML report
 *   GET  /api/ollama-status   — Checks Ollama connectivity
 *   GET  /api/ollama-models   — Lists available Ollama models
 * 
 * Port: 3000 (configurable via PORT env var)
 */

import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runScriptedTest } from './src/engines/scripted.js';
import { runExploratoryTest, checkOllamaStatus } from './src/engines/exploratory.js';
import { generateReport } from './src/utils/report-generator.js';
import { generateDocxReport } from './src/utils/docx-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

// --- Express App Setup ---
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Serve reports directory
app.use('/reports', express.static(path.join(__dirname, 'reports')));

// --- Multer setup for CSV file uploads ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  }
});

// --- In-memory store for active test runs and their SSE connections ---
const activeRuns = new Map();

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * GET /api/ollama-status
 * Check if Ollama is running and accessible
 */
app.get('/api/ollama-status', async (req, res) => {
  try {
    const status = await checkOllamaStatus(OLLAMA_URL);
    res.json({
      connected: status.available,
      url: OLLAMA_URL,
      models: status.models,
      error: status.error
    });
  } catch (error) {
    res.json({
      connected: false,
      url: OLLAMA_URL,
      models: [],
      error: error.message
    });
  }
});

/**
 * GET /api/ollama-models
 * List available Ollama models
 */
app.get('/api/ollama-models', async (req, res) => {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      return res.json({ models: [], error: `Ollama returned ${response.status}` });
    }

    const data = await response.json();
    const models = (data.models || []).map(m => ({
      name: m.name,
      size: m.size,
      modified: m.modified_at
    }));

    res.json({ models });
  } catch (error) {
    res.json({ models: [], error: error.message });
  }
});

/**
 * GET /api/reports
 * List all generated reports
 */
app.get('/api/reports', (req, res) => {
  const reportsDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(reportsDir)) {
    return res.json({ reports: [] });
  }

  try {
    const entries = fs.readdirSync(reportsDir, { withFileTypes: true });
    const reports = entries
      .filter(e => e.isDirectory())
      .map(e => {
        const reportPath = path.join(reportsDir, e.name, 'index.html');
        const exists = fs.existsSync(reportPath);
        let stat = null;
        if (exists) {
          stat = fs.statSync(reportPath);
        }
        return {
          id: e.name,
          exists,
          createdAt: stat?.birthtime?.toISOString() || null,
          url: `/report/${e.name}`
        };
      })
      .filter(r => r.exists)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    res.json({ reports });
  } catch (error) {
    res.json({ reports: [], error: error.message });
  }
});

/**
 * POST /run-test
 * Start a new test run
 * Body (multipart form):
 *   - url (string, required) — target URL
 *   - cookies (string, optional) — JSON array of cookie objects
 *   - csvFile (file, optional) — CSV file with test steps
 *   - exploratoryMode (string, optional) — "true" to enable AI mode
 *   - model (string, optional) — Ollama model name
 */
app.post('/run-test', upload.single('csvFile'), async (req, res) => {
  try {
    const { url, cookies: cookiesStr, exploratoryMode, exploratoryType, model, csvText, browsers: browsersRaw, deviceProfile } = req.body;
    const csvFile = req.file;

    // Parse browsers array
    let browsers = ['chrome'];
    if (browsersRaw) {
      if (Array.isArray(browsersRaw)) {
        browsers = browsersRaw;
      } else {
        try {
          const parsed = JSON.parse(browsersRaw);
          browsers = Array.isArray(parsed) ? parsed : [browsersRaw];
        } catch (_) {
          browsers = browsersRaw.split(',').map(b => b.trim()).filter(Boolean);
        }
      }
    }
    if (browsers.length === 0) {
      browsers = ['chrome'];
    }

    // --- Validate URL ---
    if (!url || !url.trim()) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (_) {
      return res.status(400).json({ error: 'Invalid URL format. Include http:// or https://' });
    }

    // --- Parse cookies ---
    let cookies = [];
    if (cookiesStr && cookiesStr.trim()) {
      try {
        cookies = JSON.parse(cookiesStr);
        if (!Array.isArray(cookies)) {
          return res.status(400).json({ error: 'Cookies must be a JSON array' });
        }
      } catch (err) {
        return res.status(400).json({ error: `Invalid cookies JSON: ${err.message}` });
      }
    }

    // --- Determine test mode ---
    const isExploratory = exploratoryMode === 'true' || exploratoryMode === true;
    const selectedModel = model || 'qwen2.5-coder:7b';

    // If not exploratory, CSV is required (either via file upload or raw text)
    if (!isExploratory && !csvFile && (!csvText || !csvText.trim())) {
      return res.status(400).json({
        error: 'Either upload a CSV file, write a test case, or enable AI Exploratory Mode'
      });
    }

    // Check if we need conversion and if Ollama is running
    let contentToCheck = csvText;
    if (csvFile) {
      contentToCheck = csvFile.buffer.toString('utf-8');
    }

    if (!isExploratory && contentToCheck) {
      const prepared = prepareCSVContent(contentToCheck);
      if (prepared === null) {
        const ollamaCheck = await checkOllamaStatus(OLLAMA_URL, selectedModel);
        if (!ollamaCheck.available) {
          return res.status(503).json({
            error: `Converting natural language test cases requires Ollama. Please start Ollama at ${OLLAMA_URL} or use structured CSV: Action,Selector,Value`,
            details: ollamaCheck.error
          });
        }
      }
    }

    // If exploratory, validate Ollama
    if (isExploratory) {
      const ollamaCheck = await checkOllamaStatus(OLLAMA_URL, selectedModel);
      if (!ollamaCheck.available) {
        return res.status(503).json({
          error: `Ollama is not running at ${OLLAMA_URL}. Please start Ollama first.`,
          details: ollamaCheck.error
        });
      }
    }

    // --- Create run ID ---
    const runId = `run-${Date.now()}`;
    const controller = new AbortController();
    const runData = {
      id: runId,
      status: 'running',
      mode: isExploratory ? 'exploratory' : 'scripted',
      exploratoryType: isExploratory ? (exploratoryType || 'bug-hunting') : null,
      url,
      model: selectedModel,
      startedAt: new Date().toISOString(),
      progress: [],
      sseClients: [],
      controller
    };
    activeRuns.set(runId, runData);

    // --- Respond immediately with run ID ---
    res.json({
      runId,
      status: 'started',
      mode: runData.mode,
      message: `Test run started. Connect to /test-status/${runId} for live updates.`
    });

    // --- Execute test asynchronously ---
    executeTestAsync(runData, {
      url,
      cookies,
      csvFile,
      csvText,
      isExploratory,
      exploratoryType: exploratoryType || 'bug-hunting',
      selectedModel,
      browsers,
      deviceProfile: deviceProfile || 'desktop'
    }, controller.signal);

  } catch (error) {
    console.error('Error starting test:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /cancel-test
 * Cancel a running test
 */
app.post('/cancel-test', (req, res) => {
  const { runId } = req.body;
  if (!runId) {
    return res.status(400).json({ error: 'runId is required' });
  }

  const runData = activeRuns.get(runId);
  if (!runData) {
    return res.status(404).json({ error: 'Active test run not found' });
  }

  if (runData.status !== 'running') {
    return res.status(400).json({ error: 'Test run is not active' });
  }

  if (runData.controller) {
    runData.controller.abort();
  }

  res.json({ success: true, message: 'Test cancellation signal sent' });
});

/**
 * GET /test-status/:id
 * Server-Sent Events endpoint for live test progress
 */
app.get('/test-status/:id', (req, res) => {
  const runId = req.params.id;
  const runData = activeRuns.get(runId);

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send any existing progress events (replay)
  if (runData) {
    for (const event of runData.progress) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // If already complete, send complete event and close
    if (runData.status === 'complete' || runData.status === 'error') {
      res.write(`data: ${JSON.stringify({ type: runData.status, message: runData.message || 'Done', reportUrl: runData.reportUrl })}\n\n`);
      res.end();
      return;
    }

    // Register this SSE client
    runData.sseClients.push(res);

    // Cleanup on disconnect
    req.on('close', () => {
      const idx = runData.sseClients.indexOf(res);
      if (idx !== -1) runData.sseClients.splice(idx, 1);
    });
  } else {
    // Run not found
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Test run not found' })}\n\n`);
    res.end();
  }
});

/**
 * GET /report/:id
 * Serve generated HTML report
 */
app.get('/report/:id', (req, res) => {
  const runId = req.params.id;
  const reportPath = path.join(__dirname, 'reports', runId, 'index.html');

  if (!fs.existsSync(reportPath)) {
    return res.status(404).send(`
      <html><body style="font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#1e293b;color:#f1f5f9;">
        <div style="text-align:center;">
          <h1>📋 Report Not Found</h1>
          <p>No report exists for run ID: <code>${runId}</code></p>
          <a href="/" style="color:#818cf8;">← Back to QA Tool</a>
        </div>
      </body></html>
    `);
  }

  res.sendFile(reportPath);
});


// --- Helper functions for test case input processing ---

/**
 * Prepares CSV content. If it doesn't look like CSV, returns null.
 * If it has commas on the first line, prepends the header Action,Selector,Value if missing.
 */
function prepareCSVContent(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return '';
  
  const firstLine = lines[0].toLowerCase();
  const hasHeader = firstLine.includes('action') && firstLine.includes('selector');
  
  // Define valid actions in scripted CSV mode
  const validActions = ['navigate', 'click', 'fill', 'screenshot', 'wait'];
  
  // Check if every line looks like a valid CSV step (or header)
  let looksLikeCSV = true;
  const startIdx = hasHeader ? 1 : 0;
  
  if (lines.length <= startIdx) {
    return null; // Empty or just header
  }
  
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(',');
    const action = parts[0].trim().toLowerCase();
    
    if (!validActions.includes(action)) {
      looksLikeCSV = false;
      break;
    }
  }
  
  if (looksLikeCSV) {
    if (hasHeader) {
      return rawText;
    } else {
      return `Action,Selector,Value\n${rawText}`;
    }
  }
  
  return null;
}

/**
 * Converts natural language description into valid CSV using Ollama
 */
async function convertNaturalLanguageToCSV(text, model, ollamaUrl, targetUrl, signal) {
  const baseUrl = targetUrl.replace(/\/$/, '');
  const prompt = `You are a senior QA automation engineer specializing in Playwright end-to-end testing. Convert the test description below into a precise, executable CSV test plan.

TARGET URL: ${targetUrl}

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

SELECTOR PRIORITY — always prefer in this order:
  1. ID attribute:           #login-button
  2. name attribute:         input[name="username"], input[name="email"], input[name="password"]
  3. type + tag:             input[type="email"], button[type="submit"]
  4. data-* attributes:      [data-testid="submit"], [data-id="login"]
  5. Unique class:           .login-submit (only if clearly unique)
  6. Text match (last resort): button:has-text("Sign In")

If the user explicitly provides a selector, URL, or text value — preserve it EXACTLY.

CRITICAL PATTERNS:

1. COOKIE/CONSENT BANNERS:
   Real websites show cookie banners that load asynchronously after the page.
   - After the first navigate, always add: wait,,2000
   - The test engine dismisses banners automatically. Do NOT add click steps for cookie banners.

2. MODAL/POPUP INTERACTIONS:
   - If clicking an element (like a login or signup button) triggers an animated modal/popup dialog instead of navigating, always add: wait,,2000 (for modal animation).
   - Use standard form selectors for inputs inside the modal (e.g., input[name="username"], input[name="password"], button[type="submit"]).

3. PAGE NAVIGATION / STATE CHANGES:
   - After clicking any link or button that navigates to a new page or triggers a major UI transition (like a header nav link, menu item, or redirect button), always add: wait,,1500.

4. VERIFICATION STEPS:
   - Any step containing: "verify", "assert", "check", "confirm", "should see", or "notice"
     → Replace with: screenshot,,
   - Always add a screenshot after: login success, adding items to cart, and cart/checkout page load.

EXAMPLE 1 — Modal login then navigate and click:
Input: Login as user@test.com / Pass123 then go to shop and add a product to cart
Output:
Action,Selector,Value
wait,,2000
click,.login-trigger,
wait,,2000
fill,input[name="username"],user@test.com
fill,input[name="password"],Pass123
click,button[type="submit"],
screenshot,,
click,.nav-shop,
wait,,1500
click,.add-to-cart-btn,
wait,,1000
screenshot,,
navigate,,${baseUrl}/cart
screenshot,,

EXAMPLE 2 — Verify cart item:
Input: Verify the selected product exists in the cart
Output:
Action,Selector,Value
screenshot,,

--- USER INPUT BELOW ---
${text}

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
      throw new Error(`Ollama returned ${response.status} during text conversion`);
    }

    const data = await response.json();
    let csv = data.response || '';

    // Clean up markdown blocks if Ollama included them despite rules
    let cleaned = csv.replace(/```(?:csv)?/g, '').trim();

    // Extract everything from the first "Action,Selector,Value" match to the end
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
    throw new Error(`Failed to convert natural language to CSV using Ollama: ${error.message}`);
  }
}

/**
 * Batch enrich locators with plain-English business name, functional description, and user value
 */
async function enrichLocatorsWithBusinessContext(locators, model, ollamaUrl) {
  if (!locators || locators.length === 0) return [];
  
  // Group locators by page path
  const locatorsByPage = new Map();
  for (const loc of locators) {
    if (!locatorsByPage.has(loc.page)) {
      locatorsByPage.set(loc.page, []);
    }
    locatorsByPage.get(loc.page).push(loc);
  }
  
  const enrichedList = [];
  
  for (const [pagePath, pageLocs] of locatorsByPage.entries()) {
    console.log(`[DOC-GEN] Translating/Enriching ${pageLocs.length} components on page ${pagePath}...`);
    
    // Create a trimmed representation to minimize prompt size
    const inputList = pageLocs.map(l => ({
      selector: l.selector,
      type: l.type,
      name: l.name || '',
      placeholder: l.placeholder || ''
    }));
    
    const prompt = `You are a senior business analyst and product spec writer. Analyze the following interactive user interface elements discovered on the page path "${pagePath}":

${JSON.stringify(inputList, null, 2)}

For each element, generate:
1. "featureName": A clear, reader-friendly business name for this component (e.g. "User Email Input Field", "Checkout Button").
2. "functionalDescription": A concise 1-sentence description in plain business English explaining what the component does from the customer's perspective.
3. "businessValue": A brief 1-sentence explanation of why this component is valuable to the business or user experience.

Respond ONLY with a valid JSON array matching this schema:
[
  {
    "selector": "exact CSS selector from input",
    "featureName": "...",
    "functionalDescription": "...",
    "businessValue": "..."
  }
]
Do NOT include any markdown code fences, backticks, or other text outside the JSON array.`;

    try {
      const response = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false
        }),
        signal: AbortSignal.timeout(60000)
      });
      
      if (!response.ok) {
        throw new Error(`Ollama returned status ${response.status}`);
      }
      
      const data = await response.json();
      let text = (data.response || '').trim();
      
      // Strip opening/closing code fences if present, even if incomplete (e.g. truncated response)
      let cleaned = text.replace(/^```(json)?/i, '').trim();
      cleaned = cleaned.replace(/```$/, '').trim();
      
      let parsed = [];
      try {
        const arrayStart = cleaned.indexOf('[');
        const arrayEnd = cleaned.lastIndexOf(']');
        if (arrayStart !== -1 && arrayEnd > arrayStart) {
          parsed = JSON.parse(cleaned.substring(arrayStart, arrayEnd + 1));
        } else {
          parsed = JSON.parse(cleaned);
        }
      } catch (e) {
        console.warn(`[DOC-GEN] Failed to parse JSON from Ollama business context: ${e.message}`);
      }
      
      const enrichedMap = new Map((parsed || []).map(item => [item.selector, item]));
      
      for (const loc of pageLocs) {
        const enriched = enrichedMap.get(loc.selector);
        enrichedList.push({
          ...loc,
          featureName: enriched?.featureName || loc.name || loc.placeholder || 'Interactive Element',
          functionalDescription: enriched?.functionalDescription || `Allows user interaction with the ${loc.type || 'component'} element.`,
          businessValue: enriched?.businessValue || 'Improves page engagement and usability.'
        });
      }
    } catch (err) {
      console.warn(`[DOC-GEN] Failed to enrich locators for page ${pagePath}: ${err.message}`);
      for (const loc of pageLocs) {
        enrichedList.push({
          ...loc,
          featureName: loc.name || loc.placeholder || 'Interactive Element',
          functionalDescription: `Allows user interaction with the ${loc.type || 'component'} element.`,
          businessValue: 'Improves page engagement and usability.'
        });
      }
    }
  }
  
  return enrichedList;
}


// ============================================================================
// ASYNC TEST EXECUTION
// ============================================================================

/**
 * Execute test asynchronously and stream progress via SSE
 */
async function executeTestAsync(runData, testConfig, signal) {
  const { url, cookies, csvFile, csvText, isExploratory, exploratoryType = 'bug-hunting', selectedModel, browsers = ['chrome'], deviceProfile = 'desktop' } = testConfig;
  const startTime = new Date();

  // Progress callback that broadcasts to all SSE clients
  const onProgress = (event) => {
    runData.progress.push(event);

    const sseData = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of runData.sseClients) {
      try {
        client.write(sseData);
      } catch (_) { /* client disconnected */ }
    }
  };

  try {
    let compiledCsvContent = null;
    if (!isExploratory) {
      let content = csvFile ? csvFile.buffer.toString('utf-8') : csvText;
      
      const prepared = prepareCSVContent(content);
      if (prepared === null) {
        onProgress({ type: 'status', message: '🤖 Converting natural language steps to structured CSV using Ollama...' });
        try {
          compiledCsvContent = await convertNaturalLanguageToCSV(content, selectedModel, OLLAMA_URL, url, signal);
          onProgress({ type: 'info', message: `Successfully compiled natural language test case to CSV:\n\n${compiledCsvContent}` });
        } catch (err) {
          throw new Error(`AI translation failed: ${err.message}`);
        }
      } else {
        compiledCsvContent = prepared;
      }
    }

    const resultsByBrowser = {};
    const runnerPromises = browsers.map(async (browserName) => {
      // Create a browser-specific progress callback
      const browserOnProgress = (event) => {
        onProgress({ ...event, browser: browserName });
      };

      try {
        browserOnProgress({ type: 'status', message: `Starting test execution on ${browserName}...` });
        let runResult;

        if (isExploratory) {
          runResult = await runExploratoryTest({
            url,
            cookies,
            model: selectedModel,
            ollamaUrl: OLLAMA_URL,
            runId: runData.id,
            onProgress: browserOnProgress,
            signal,
            browserName,
            exploratoryType,
            deviceProfile
          });
        } else {
          runResult = await runScriptedTest({
            url,
            cookies,
            csvContent: compiledCsvContent,
            model: selectedModel,
            ollamaUrl: OLLAMA_URL,
            runId: runData.id,
            onProgress: browserOnProgress,
            signal,
            browserName,
            deviceProfile
          });
        }

        resultsByBrowser[browserName] = runResult;
        browserOnProgress({ type: 'browser-status', status: 'passed' });
      } catch (error) {
        console.error(`Browser run failed for ${browserName}:`, error);
        browserOnProgress({ type: 'browser-status', status: 'failed', error: error.message });

        // Fallback result for failed browser execution
        resultsByBrowser[browserName] = {
          testName: isExploratory ? 'AI Exploratory Test' : 'Scripted Test (CSV)',
          url,
          mode: isExploratory ? 'exploratory' : 'scripted',
          model: selectedModel,
          startTime: startTime.toISOString(),
          endTime: new Date().toISOString(),
          steps: [
            {
              name: `Execution failure on ${browserName}`,
              action: 'system',
              selector: '',
              value: '',
              status: 'failed',
              duration: 0,
              error: error.message,
              screenshot: null,
              reason: `Execution failed: ${error.message}`
            }
          ],
          consoleErrors: [],
          cookies
        };
      }
    });

    // Run tests concurrently across selected browsers
    await Promise.all(runnerPromises);

    const endTime = new Date();
    const consolidatedResults = {
      testName: isExploratory ? 'AI Exploratory Test' : 'Scripted Test (CSV)',
      url,
      mode: isExploratory ? 'exploratory' : 'scripted',
      exploratoryType: isExploratory ? exploratoryType : null,
      model: selectedModel,
      deviceProfile,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      browsers: resultsByBrowser,
      cookies
    };

    // --- Generate Report ---
    onProgress({ type: 'status', message: '📄 Generating report...' });
    const reportPath = generateReport(runData.id, consolidatedResults);
    const reportUrl = `/report/${runData.id}`;

    // --- Generate Site Documentation Markdown if requested ---
    console.log(`[DOC-GEN] Checking documentation gen conditions: isExploratory=${isExploratory}, exploratoryType=${exploratoryType}`);
    if (isExploratory && exploratoryType === 'documentation') {
      try {
        console.log('[DOC-GEN] Starting business enrichment for locators...');
        onProgress({ type: 'status', message: '🤖 Enriching discovered components with Business Value descriptions using Ollama...' });
        const browsersData = consolidatedResults.browsers || {};
        for (const browserName of Object.keys(browsersData)) {
          const bData = browsersData[browserName];
          if (bData && bData.crawlResults && bData.crawlResults.locators) {
            bData.crawlResults.locators = await enrichLocatorsWithBusinessContext(
              bData.crawlResults.locators,
              selectedModel,
              OLLAMA_URL
            );
          }
        }

        console.log('[DOC-GEN] Starting site documentation compilation...');
        onProgress({ type: 'status', message: '📝 Compiling site documentation markdown...' });
        const docMarkdownPath = compileSiteDocumentation(runData.id, consolidatedResults);
        console.log(`[DOC-GEN] Markdown compiled: ${docMarkdownPath}`);
        onProgress({ type: 'info', message: `✅ Site documentation compiled successfully: ${docMarkdownPath}` });

        console.log('[DOC-GEN] Starting Word spec compilation...');
        onProgress({ type: 'status', message: '📝 Generating Word Functional Specification (.docx)...' });
        const docxPath = await generateDocxReport(runData.id, consolidatedResults);
        console.log(`[DOC-GEN] Word spec compiled: ${docxPath}`);
        onProgress({ type: 'info', message: `✅ Word Functional Specification generated: ${docxPath}` });
      } catch (docErr) {
        console.error('[DOC-GEN] Failed to compile site documentation:', docErr);
        onProgress({ type: 'warning', message: `⚠️ Failed to compile site documentation: ${docErr.message}` });
      }
    }

    // Update run data
    runData.status = 'complete';
    runData.reportUrl = reportUrl;
    runData.message = 'Test complete';

    // Calculate aggregated overall test metrics (Total Steps, Passed, Failed) for summary
    let overallTotal = 0;
    let overallPassed = 0;
    let overallFailed = 0;

    for (const b of Object.keys(resultsByBrowser)) {
      const r = resultsByBrowser[b];
      overallTotal += r.steps.length;
      overallPassed += r.steps.filter(s => s.status === 'passed').length;
      overallFailed += r.steps.filter(s => s.status === 'failed').length;
    }

    // Notify all SSE clients
    const completeEvent = {
      type: 'complete',
      message: 'Test execution complete! Report is ready.',
      reportUrl,
      summary: {
        total: overallTotal,
        passed: overallPassed,
        failed: overallFailed,
        exploratoryType: isExploratory ? exploratoryType : null,
        duration: ((endTime - startTime) / 1000).toFixed(2) + 's'
      }
    };

    const sseData = `data: ${JSON.stringify(completeEvent)}\n\n`;
    for (const client of runData.sseClients) {
      try {
        client.write(sseData);
        client.end();
      } catch (_) { /* client disconnected */ }
    }

    console.log(`✅ Test run ${runData.id} complete. Report: ${reportUrl}`);

  } catch (error) {
    console.error(`❌ Test run ${runData.id} failed:`, error);

    runData.status = 'error';
    runData.message = error.message;

    const errorEvent = { type: 'error', message: `Test failed: ${error.message}` };
    const sseData = `data: ${JSON.stringify(errorEvent)}\n\n`;
    for (const client of runData.sseClients) {
      try {
        client.write(sseData);
        client.end();
      } catch (_) { /* client disconnected */ }
    }
  }

  // Cleanup SSE clients
  runData.sseClients = [];
}


/**
 * Merges browser crawl results and creates a consolidated Markdown Business Feature Specification.
 */
function compileSiteDocumentation(runId, results) {
  const reportsDir = path.join(__dirname, 'reports', runId);
  const screenshotsDir = path.join(reportsDir, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const sitemapMap = new Map(); // pathname -> { title, headings }
  const locatorsMap = new Map(); // key -> locator object
  const allTransitions = [];

  const browsersData = results.browsers || {};
  for (const browserName of Object.keys(browsersData)) {
    const bData = browsersData[browserName];
    if (!bData || !bData.crawlResults) continue;

    const { sitemap = [], locators = [], transitions = [] } = bData.crawlResults;

    // 1. Merge sitemaps
    for (const [pathname, data] of sitemap) {
      const title = typeof data === 'string' ? data : (data.title || pathname);
      const headings = typeof data === 'string' ? [] : (data.headings || []);
      if (!sitemapMap.has(pathname) || (title && (!sitemapMap.get(pathname) || sitemapMap.get(pathname).title === pathname))) {
        sitemapMap.set(pathname, { title, headings });
      }
    }

    // 2. Merge locators
    for (const loc of locators) {
      const key = `${loc.page}::${loc.selector}`;
      if (!locatorsMap.has(key)) {
        locatorsMap.set(key, loc);
      }
    }

    // 3. Process transitions and save screenshots
    transitions.forEach((t, index) => {
      let relativeScreenshotPath = '';
      if (t.screenshot) {
        const screenshotFilename = `step-${index + 1}-${browserName}.png`;
        const absoluteScreenshotPath = path.join(screenshotsDir, screenshotFilename);
        try {
          fs.writeFileSync(absoluteScreenshotPath, Buffer.from(t.screenshot, 'base64'));
          relativeScreenshotPath = `screenshots/${screenshotFilename}`;
        } catch (err) {
          console.warn(`Failed to write screenshot file: ${err.message}`);
        }
      }

      allTransitions.push({
        browser: browserName,
        from: t.from,
        to: t.to,
        action: t.action,
        reason: t.reason,
        relativeScreenshotPath
      });
    });
  }

  // Generate sitemap markdown table
  let sitemapMd = '| No. | Page Title | Visited URL Pathname | Heading Hierarchy Detected |\n| --- | --- | --- | --- |\n';
  if (sitemapMap.size === 0) {
    sitemapMd += '| (None) | (No pages cataloged) | (None) | (None) |\n';
  } else {
    let index = 1;
    for (const [pathname, data] of sitemapMap.entries()) {
      const headingsStr = data.headings && data.headings.length
        ? data.headings.map(h => `${h.tag}: "${h.text}"`).join('<br>')
        : 'None';
      sitemapMd += `| ${index}. | **${data.title}** | \`${pathname}\` | ${headingsStr} |\n`;
      index++;
    }
  }

  // Generate Business Feature Catalog
  let locatorsMd = '| Page Name | Feature/Component | Functional Description | Business / User Value |\n| --- | --- | --- | --- |\n';
  if (locatorsMap.size === 0) {
    locatorsMd += '| (None) | (No elements cataloged) | (None) | (None) |\n';
  } else {
    for (const loc of locatorsMap.values()) {
      const pageName = loc.page || '/';
      const featureName = loc.featureName || loc.name || loc.placeholder || 'Interactive Element';
      const desc = loc.functionalDescription || 'Allows user interaction.';
      const bizVal = loc.businessValue || 'Improves usability.';
      locatorsMd += `| **${pageName}** | ${featureName} | ${desc} | ${bizVal} |\n`;
    }
  }

  // Generate transitions user journey summary
  let journeyMd = '';
  if (allTransitions.length === 0) {
    journeyMd = '_No page transitions recorded._\n';
  } else {
    // Group transitions by browser
    const browsers = [...new Set(allTransitions.map(t => t.browser))];
    for (const browser of browsers) {
      const bTransitions = allTransitions.filter(t => t.browser === browser);
      journeyMd += `### Browser Run: **${browser.toUpperCase()}**\n\n`;
      bTransitions.forEach((t, idx) => {
        journeyMd += `#### Step ${idx + 1}: ${t.action}\n\n`;
        if (t.reason) {
          journeyMd += `**Functional Intent**: *"${t.reason}"*\n\n`;
        }
        journeyMd += `- **From Path**: \`${t.from}\`\n`;
        journeyMd += `- **To Path**: \`${t.to}\`\n\n`;
        if (t.relativeScreenshotPath) {
          journeyMd += `**Visual Proof**:\n![Screenshot for Step ${idx + 1}](${t.relativeScreenshotPath})\n\n`;
        }
        journeyMd += '---\n\n';
      });
    }
  }

  // Assemble full markdown report
  const timestamp = new Date().toLocaleString();
  const markdownContent = `# 📑 WEBSITE BUSINESS SPECIFICATION & FUNCTIONAL INVENTORY
  
This document was automatically generated during an AI-powered business functional crawl.

- **Target Website**: [${results.url}](${results.url})
- **Crawl Mode**: \`Business Auto-Doc Mode (High-Level Summary)\`
- **Crawl Date/Time**: ${timestamp}
- **AI Explorer Model**: \`${results.model}\` (Ollama)
- **Browser Executed**: \`Chrome (Headless)\`

---

## 🗺️ Section 1: Site Sitemap
Below is the list of unique page routes mapped by the AI crawler.

${sitemapMd}

---

## 🔍 Section 2: Business Feature Catalog (Functional Inventory)
A comprehensive catalog of major UI elements, components, and sections discovered on each page, written in plain business English.

${locatorsMd}

---

## 🛣️ Section 3: User Journey & Visual Walkthrough
A sequential timeline showing exactly how the AI traversed the site, with explanations and visual proofs.

${journeyMd}
`;

  const mdPath = path.join(reportsDir, 'documentation-report.md');
  fs.writeFileSync(mdPath, markdownContent, 'utf-8');
  return mdPath;
}


// ============================================================================
// SERVER STARTUP
// ============================================================================

// Ensure reports directory exists
const reportsDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

/**
 * Helper function to find and remove report folders older than 3 days.
 * Determines the age of each folder using either its timestamp suffix (e.g. run-[timestamp])
 * or filesystem modification metadata (fs.statSync().mtimeMs) for folders without a suffix.
 */
function cleanupOldReports() {
  console.log('[CLEANUP] Starting cleanup of old reports...');
  const dirPath = path.join(__dirname, 'reports');
  if (!fs.existsSync(dirPath)) {
    return;
  }
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const now = Date.now();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    let deletedCount = 0;

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const folderPath = path.join(dirPath, entry.name);
        let folderTimestamp = null;
        const match = entry.name.match(/^run-(\d+)$/);
        if (match) {
          folderTimestamp = parseInt(match[1], 10);
        } else {
          try {
            const stats = fs.statSync(folderPath);
            folderTimestamp = stats.mtimeMs;
          } catch (statErr) {
            console.error(`[CLEANUP] Failed to read stat for ${entry.name}:`, statErr);
          }
        }

        if (folderTimestamp && (now - folderTimestamp > threeDaysMs)) {
          console.log(`[CLEANUP] Deleting old report folder: ${entry.name}`);
          try {
            fs.rmSync(folderPath, { recursive: true, force: true });
            deletedCount++;
          } catch (deleteErr) {
            console.error(`[CLEANUP] Failed to delete folder ${entry.name}:`, deleteErr);
          }
        }
      }
    }
    console.log(`[CLEANUP] Cleanup complete. Deleted ${deletedCount} report folders.`);
  } catch (err) {
    console.error('[CLEANUP] Error during report cleanup:', err);
  }
}

// Run cleanup immediately on startup and schedule every 24 hours
cleanupOldReports();
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
setInterval(cleanupOldReports, CLEANUP_INTERVAL);

const server = app.listen(PORT, () => {
  console.log(`
╭──────────────────────────────────────────────────────────────╮
│                                                              │
│   🧪 QA Automation Tool                                     │
│                                                              │
│   Server running at:  http://localhost:${PORT}                 │
│   Ollama endpoint:    ${OLLAMA_URL.padEnd(36)}│
│                                                              │
│   Endpoints:                                                 │
│     GET  /                  — Frontend UI                    │
│     POST /run-test          — Start a test run               │
│     GET  /test-status/:id   — Live progress (SSE)            │
│     GET  /report/:id        — View test report               │
│     GET  /api/ollama-status — Check Ollama                   │
│     GET  /api/ollama-models — List models                    │
│                                                              │
╰──────────────────────────────────────────────────────────────╯
  `);
});

export { server };
export default app;
