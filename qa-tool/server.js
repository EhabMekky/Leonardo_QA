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
import { runScriptedTest } from './scripted.js';
import { runExploratoryTest, checkOllamaStatus } from './exploratory.js';
import { generateReport } from './report-generator.js';

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
    const { url, cookies: cookiesStr, exploratoryMode, model, csvText } = req.body;
    const csvFile = req.file;

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
    const runData = {
      id: runId,
      status: 'running',
      mode: isExploratory ? 'exploratory' : 'scripted',
      url,
      model: selectedModel,
      startedAt: new Date().toISOString(),
      progress: [],
      sseClients: []
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
      selectedModel
    });

  } catch (error) {
    console.error('Error starting test:', error);
    res.status(500).json({ error: error.message });
  }
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
  if (hasHeader) {
    return rawText;
  }
  
  // If the first line contains a comma, check if it starts with a valid action
  const firstLineHasComma = lines[0].includes(',');
  if (firstLineHasComma) {
    const firstWord = firstLine.split(',')[0].trim();
    const validActions = ['navigate', 'click', 'fill', 'screenshot', 'wait'];
    if (validActions.includes(firstWord)) {
      return `Action,Selector,Value\n${rawText}`;
    }
  }
  
  return null;
}

/**
 * Converts natural language description into valid CSV using Ollama
 */
async function convertNaturalLanguageToCSV(text, model, ollamaUrl, targetUrl) {
  const prompt = `You are a QA automation expert. Convert the following input into a structured CSV format with columns: Action,Selector,Value.
The input might be explicit test steps OR a high-level scenario (e.g., "Test error handling if user add wrong username or password"). If it's a high-level scenario, break it down into logical, concrete steps (navigate, fill, click, etc.) to achieve the goal.

Target URL for this test: ${targetUrl}

Available actions:
- navigate (Value: URL, Selector: empty)
- click (Selector: CSS selector of the button/link, Value: empty)
- fill (Selector: CSS selector, Value: text to type)
- wait (Value: milliseconds, Selector: empty)
- screenshot (Selector: empty, Value: empty)

Rules:
1. Output ONLY the valid CSV content starting with "Action,Selector,Value" header.
2. Do not include markdown code blocks (like \`\`\`csv) or any conversational text.
3. Guess stable CSS selectors based on standard web practices (e.g. input[type="text"], input[name="username"], button[type="submit"], #user-name, #password, #login-button).
4. For actions like "Notice error message" or "Verify...", convert them to a "screenshot" action to capture the state.

Input:
${text}

Output:`;

  try {
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false
      })
    });

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


// ============================================================================
// ASYNC TEST EXECUTION
// ============================================================================

/**
 * Execute test asynchronously and stream progress via SSE
 */
async function executeTestAsync(runData, testConfig) {
  const { url, cookies, csvFile, csvText, isExploratory, selectedModel } = testConfig;

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
    let results;

    if (isExploratory) {
      // --- AI Exploratory Mode ---
      results = await runExploratoryTest({
        url,
        cookies,
        model: selectedModel,
        ollamaUrl: OLLAMA_URL,
        onProgress
      });
    } else {
      // --- Scripted CSV Mode ---
      let content = csvFile ? csvFile.buffer.toString('utf-8') : csvText;
      
      const prepared = prepareCSVContent(content);
      if (prepared === null) {
        onProgress({ type: 'status', message: '🤖 Converting natural language steps to structured CSV using Ollama...' });
        try {
          content = await convertNaturalLanguageToCSV(content, selectedModel, OLLAMA_URL, url);
          onProgress({ type: 'info', message: `Successfully compiled natural language test case to CSV:\n\n${content}` });
        } catch (err) {
          throw new Error(`AI translation failed: ${err.message}`);
        }
      } else {
        content = prepared;
      }

      results = await runScriptedTest({
        url,
        cookies,
        csvContent: content,
        model: selectedModel,
        onProgress
      });
    }

    // --- Generate Report ---
    onProgress({ type: 'status', message: '📄 Generating report...' });
    const reportPath = generateReport(runData.id, results);
    const reportUrl = `/report/${runData.id}`;

    // Update run data
    runData.status = 'complete';
    runData.reportUrl = reportUrl;
    runData.message = 'Test complete';

    // Notify all SSE clients
    const completeEvent = {
      type: 'complete',
      message: 'Test execution complete! Report is ready.',
      reportUrl,
      summary: {
        total: results.steps.length,
        passed: results.steps.filter(s => s.status === 'passed').length,
        failed: results.steps.filter(s => s.status === 'failed').length,
        duration: results.startTime && results.endTime
          ? ((new Date(results.endTime) - new Date(results.startTime)) / 1000).toFixed(2) + 's'
          : 'N/A'
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


// ============================================================================
// SERVER STARTUP
// ============================================================================

// Ensure reports directory exists
const reportsDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

app.listen(PORT, () => {
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

export default app;
