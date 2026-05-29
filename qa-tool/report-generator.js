/**
 * report-generator.js — Allure-style HTML Report Builder
 * 
 * Generates beautiful, interactive HTML reports for test runs with:
 * - Summary cards (total, passed, failed, pass rate)
 * - Collapsible step-by-step execution log
 * - Inline screenshots (base64 encoded)
 * - Console error capture
 * - Duration tracking per step and overall
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Generate an Allure-style HTML report from test results
 * @param {string} runId - Unique identifier for this test run
 * @param {Object} testResults - Structured test results object
 * @returns {string} Path to the generated report
 */
export function generateReport(runId, testResults) {
  const reportsDir = path.join(__dirname, 'reports', runId);
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const html = buildReportHTML(runId, testResults);
  const reportPath = path.join(reportsDir, 'index.html');
  fs.writeFileSync(reportPath, html, 'utf-8');

  console.log(`📄 Report generated: ${reportPath}`);
  return reportPath;
}

/**
 * Build the complete HTML string for the report
 */
function buildReportHTML(runId, results) {
  const {
    testName = 'QA Test Run',
    url = '',
    mode = 'scripted',
    model = 'N/A',
    deviceProfile = 'desktop',
    startTime,
    endTime,
    cookies = []
  } = results;

  // Fallback support for single-browser or legacy structure
  let browsersData = results.browsers;
  if (!browsersData) {
    browsersData = {
      chrome: {
        steps: results.steps || [],
        consoleErrors: results.consoleErrors || []
      }
    };
  }

  // Aggregate overall metrics across all active browsers
  let totalSteps = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const b of Object.keys(browsersData)) {
    const bData = browsersData[b];
    const steps = bData.steps || [];
    totalSteps += steps.length;
    passed += steps.filter(s => s.status === 'passed').length;
    failed += steps.filter(s => s.status === 'failed').length;
    skipped += steps.filter(s => s.status === 'skipped').length;
  }

  const passRate = totalSteps > 0 ? ((passed / totalSteps) * 100).toFixed(1) : '0.0';
  const duration = startTime && endTime
    ? ((new Date(endTime) - new Date(startTime)) / 1000).toFixed(2)
    : '0.00';
  const overallStatus = failed > 0 ? 'failed' : 'passed';
  const timestamp = new Date(startTime || Date.now()).toLocaleString('en-US', {
    dateStyle: 'full',
    timeStyle: 'medium'
  });

  const browserKeys = Object.keys(browsersData);
  const hasOverallConsoleErrors = Object.values(browsersData).some(bData => (bData.consoleErrors || []).length > 0);

  // Build browser-specific step lists & console error lists
  const reportTabsHTML = `
    <div class="report-tabs">
      ${browserKeys.map((b, idx) => {
        const bData = browsersData[b];
        const failedCount = (bData.steps || []).filter(s => s.status === 'failed').length;
        const badgeClass = failedCount > 0 ? 'failed' : 'passed';
        const badgeText = failedCount > 0 ? '❌ Failed' : '✅ Passed';
        return `
          <button class="report-tab-btn ${idx === 0 ? 'active' : ''}" onclick="showBrowserReport('${b}')" data-browser="${b}">
            <span>${b.toUpperCase()}</span>
            <span class="tab-status-badge ${badgeClass}">${badgeText}</span>
          </button>
        `;
      }).join('\n')}
    </div>
  `;

  // Build steps contents
  const stepsContentsHTML = `
    <div class="browser-report-contents">
      ${browserKeys.map((b, idx) => {
        const bData = browsersData[b];
        const steps = bData.steps || [];
        const stepRows = steps.map((step, sIdx) => buildStepRow(step, sIdx, b)).join('\n');
        
        // Check if video file exists on disk
        const videoUrl = `/reports/${runId}/video-${b}.webm`;
        const videoPath = path.join(__dirname, 'reports', runId, `video-${b}.webm`);
        const hasVideo = fs.existsSync(videoPath);
        
        const videoPlayerHTML = hasVideo
          ? `<div class="video-player-container">
              <h3>🎥 Browser Execution Recording (${b.toUpperCase()})</h3>
              <video controls width="100%" preload="metadata" style="max-width: 800px; border-radius: 8px; border: 1px solid #e2e8f0; margin-bottom: 20px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
                <source src="${videoUrl}" type="video/webm">
                Your browser does not support the video tag.
              </video>
             </div>`
          : '';

        return `
          <div id="browser-steps-${b}" class="browser-steps-content" style="display: ${idx === 0 ? 'block' : 'none'};">
            ${videoPlayerHTML}
            <div class="steps-container">
              ${stepRows || '<div class="no-steps">No test steps recorded</div>'}
            </div>
          </div>
        `;
      }).join('\n')}
    </div>
  `;

  // Build console errors content
  const consoleErrorsContentsHTML = hasOverallConsoleErrors
    ? `
    <section id="console-errors" class="section">
      <h2>🔴 Console Errors</h2>
      <div class="browser-errors-contents">
        ${browserKeys.map((b, idx) => {
          const bData = browsersData[b];
          const consoleErrors = bData.consoleErrors || [];
          const consoleErrorsHTML = consoleErrors.length > 0
            ? `<div class="console-errors">
                <h3>🔴 Console Errors Captured on ${b.toUpperCase()} (${consoleErrors.length})</h3>
                <div class="error-list">
                  ${consoleErrors.map(e => `<div class="error-item"><span class="error-time">${e.timestamp || ''}</span> <span class="error-msg">${escapeHtml(e.message || e)}</span></div>`).join('\n')}
                </div>
              </div>`
            : '<div class="no-steps">No console errors recorded</div>';
          return `
            <div id="browser-errors-${b}" class="browser-errors-content" style="display: ${idx === 0 ? 'block' : 'none'};">
              ${consoleErrorsHTML}
            </div>
          `;
        }).join('\n')}
      </div>
    </section>
    `
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Report — ${escapeHtml(testName)}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    ${getReportCSS()}
  </style>
</head>
<body>
  <!-- Sidebar -->
  <aside class="sidebar">
    <div class="sidebar-header">
      <div class="logo">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 11l3 3L22 4"/>
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
        </svg>
        <span>QA Report</span>
      </div>
    </div>
    <nav class="sidebar-nav">
      <a href="#overview" class="nav-item active">📊 Overview</a>
      <a href="#steps" class="nav-item">📋 Test Steps</a>
      ${hasOverallConsoleErrors ? '<a href="#console-errors" class="nav-item">🔴 Console Errors</a>' : ''}
      <a href="#environment" class="nav-item">⚙️ Environment</a>
    </nav>
    <div class="sidebar-footer">
      <div class="run-id">Run: ${escapeHtml(runId)}</div>
    </div>
  </aside>

  <!-- Main Content -->
  <main class="content">
    <!-- Header -->
    <header class="report-header">
      <div class="header-left">
        <h1>${escapeHtml(testName)}</h1>
        <p class="timestamp">${timestamp}</p>
      </div>
      <div class="header-right" style="display: flex; align-items: center; gap: 12px;">
        ${results.exploratoryType === 'documentation'
          ? `<a href="/reports/${runId}/documentation-spec.docx" download class="overall-badge passed" style="text-decoration: none; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: #1565c0; border: 1px solid #cbd5e1; background: #e3f2fd;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 2px;">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
              </svg>
              Download Business Spec
             </a>`
          : ''
        }
        <span class="overall-badge ${overallStatus}">${overallStatus === 'passed' ? '✓ PASSED' : '✗ FAILED'}</span>
      </div>
    </header>

    <!-- Overview Section -->
    <section id="overview" class="section">
      <div class="summary-cards">
        <div class="card card-total">
          <div class="card-value">${totalSteps}</div>
          <div class="card-label">Total Steps</div>
        </div>
        <div class="card card-passed">
          <div class="card-value">${passed}</div>
          <div class="card-label">Passed</div>
        </div>
        <div class="card card-failed">
          <div class="card-value">${failed}</div>
          <div class="card-label">Failed</div>
        </div>
        <div class="card card-skipped">
          <div class="card-value">${skipped}</div>
          <div class="card-label">Skipped</div>
        </div>
      </div>

      <!-- Pass Rate Bar -->
      <div class="pass-rate-container">
        <div class="pass-rate-header">
          <span>Pass Rate</span>
          <span class="pass-rate-value">${passRate}%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill ${overallStatus}" style="width: ${passRate}%"></div>
        </div>
      </div>

      <!-- Duration -->
      <div class="duration-bar">
        <span>⏱️ Total Duration: <strong>${duration}s</strong></span>
      </div>
    </section>

    <!-- Test Steps Section -->
    <section id="steps" class="section">
      <h2>📋 Test Steps</h2>
      ${reportTabsHTML}
      ${stepsContentsHTML}
    </section>

    <!-- Console Errors Section -->
    ${consoleErrorsContentsHTML}

    <!-- Environment Section -->
    <section id="environment" class="section">
      <h2>⚙️ Environment</h2>
      <table class="env-table">
        <tr><td>URL</td><td><a href="${escapeHtml(url)}" target="_blank">${escapeHtml(url)}</a></td></tr>
        <tr><td>Mode</td><td><span class="mode-badge ${mode}">${results.exploratoryType === 'documentation' ? '🤖 AI Business Auto-Doc' : (mode === 'exploratory' ? '🤖 AI Bug Hunter' : '📄 Scripted (CSV)')}</span></td></tr>
        ${results.exploratoryType === 'documentation'
          ? `<tr><td>Functional Spec</td><td><a href="/reports/${runId}/documentation-spec.docx" download style="font-weight: 600; color: #4f46e5; text-decoration: none;">📥 Download Word Business Spec (.docx)</a></td></tr>`
          : ''
        }
        <tr><td>Ollama Model</td><td>${escapeHtml(model)}</td></tr>
        <tr><td>Device Emulation</td><td>${deviceProfile && deviceProfile !== 'desktop' ? `<code>${escapeHtml(deviceProfile)}</code>` : 'Desktop (1280x720)'}</td></tr>
        <tr><td>Active Browsers</td><td>${browserKeys.map(b => `<span class="mode-badge scripted" style="margin-right: 5px; text-transform: uppercase;">${b}</span>`).join('')}</td></tr>
        <tr><td>Duration</td><td>${duration}s</td></tr>
        <tr><td>Cookies</td><td>${cookies.length} injected</td></tr>
        <tr><td>Run ID</td><td><code>${escapeHtml(runId)}</code></td></tr>
      </table>
    </section>
  </main>

  <script>
    ${getReportJS()}
  </script>
</body>
</html>`;
}

/**
 * Build a single step row with collapsible details
 */
function buildStepRow(step, index, browser) {
  const {
    name = `Step ${index + 1}`,
    action = '',
    selector = '',
    value = '',
    status = 'unknown',
    duration = 0,
    error = null,
    screenshot = null,
    reason = ''
  } = step;

  const statusIcon = status === 'passed' ? '✓' : status === 'failed' ? '✗' : '⊘';
  const statusClass = status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'skipped';
  const toggleId = `${browser}-${index}`;

  // Build screenshot HTML if available
  const screenshotHTML = screenshot
    ? `<div class="step-screenshot">
        <img src="data:image/png;base64,${screenshot}" alt="Screenshot for ${escapeHtml(name)}" loading="lazy" onclick="this.classList.toggle('expanded')"/>
      </div>`
    : '';

  // Build error HTML if present
  const errorHTML = error
    ? `<div class="step-error"><strong>Error:</strong> ${escapeHtml(error)}</div>`
    : '';

  // Build reason HTML if present
  const reasonHTML = reason
    ? `<div class="step-reason"><strong>AI Reason:</strong> ${escapeHtml(reason)}</div>`
    : '';

  // Build diagnostics HTML if present
  let diagnosticsHTML = '';
  if (step.diagnostics) {
    const diag = step.diagnostics;
    const ai = diag.aiAnalysis || {};
    const remediationItems = Array.isArray(ai.remediation)
      ? ai.remediation.map(item => `<li>${escapeHtml(item)}</li>`).join('')
      : '';

    diagnosticsHTML = `
      <div class="diagnostics-card" onclick="event.stopPropagation()">
        <div class="diagnostics-header">
          <span class="diagnostics-icon">🤖</span>
          <strong>AI Debugger Insights</strong>
        </div>
        <div class="diagnostics-body">
          <div class="diag-section">
            <span class="diag-subtitle">Explanation:</span>
            <p class="diag-text">${escapeHtml(ai.explanation || '')}</p>
          </div>
          <div class="diag-section">
            <span class="diag-subtitle">Root Cause:</span>
            <p class="diag-text">${escapeHtml(ai.rootCause || '')}</p>
          </div>
          ${remediationItems ? `
          <div class="diag-section">
            <span class="diag-subtitle">Remediation Steps:</span>
            <ul class="remediation-list">
              ${remediationItems}
            </ul>
          </div>` : ''}
        </div>
        
        ${diag.elementHtml ? `
        <div class="dom-context-section">
          <button class="dom-toggle-btn" type="button" onclick="event.stopPropagation(); toggleDomContext('${toggleId}')">
            <span>📁 DOM Snippet Context</span>
            <span class="dom-chevron" id="dom-chevron-${toggleId}">▸</span>
          </button>
          <div class="dom-context-body" id="dom-context-${toggleId}" style="display: none;">
            <div class="code-header">Failed Element HTML</div>
            <pre><code>${escapeHtml(diag.elementHtml)}</code></pre>
            ${diag.parentHtml ? `
            <div class="code-header">Parent Container HTML</div>
            <pre><code>${escapeHtml(diag.parentHtml)}</code></pre>
            ` : ''}
          </div>
        </div>` : ''}
      </div>
    `;
  }

  return `
    <div class="step-item ${statusClass}" data-step-index="${toggleId}">
      <div class="step-header" onclick="toggleStep('${toggleId}')">
        <div class="step-left">
          <span class="step-status-icon ${statusClass}">${statusIcon}</span>
          <span class="step-number">#${index + 1}</span>
          <span class="step-name">${escapeHtml(name)}</span>
        </div>
        <div class="step-right">
          <span class="step-duration">${(duration / 1000).toFixed(2)}s</span>
          <span class="step-chevron" id="chevron-${toggleId}">▸</span>
        </div>
      </div>
      <div class="step-details" id="step-details-${toggleId}" style="display:none;">
        <div class="step-meta">
          <div class="meta-row"><span class="meta-label">Action:</span> <code>${escapeHtml(action)}</code></div>
          ${selector ? `<div class="meta-row"><span class="meta-label">Selector:</span> <code>${escapeHtml(selector)}</code></div>` : ''}
          ${value ? `<div class="meta-row"><span class="meta-label">Value:</span> <code>${escapeHtml(value)}</code></div>` : ''}
        </div>
        ${reasonHTML}
        ${errorHTML}
        ${diagnosticsHTML}
        ${screenshotHTML}
      </div>
    </div>`;
}

/**
 * Get the CSS for the report
 */
function getReportCSS() {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #f8f9fb;
      color: #1e293b;
      display: flex;
      min-height: 100vh;
    }

    /* Sidebar */
    .sidebar {
      width: 240px;
      background: #1e293b;
      color: #94a3b8;
      display: flex;
      flex-direction: column;
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      z-index: 10;
    }

    .sidebar-header {
      padding: 20px;
      border-bottom: 1px solid #334155;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      color: #f1f5f9;
      font-size: 18px;
      font-weight: 700;
    }

    .sidebar-nav {
      flex: 1;
      padding: 16px 0;
    }

    .nav-item {
      display: block;
      padding: 10px 20px;
      color: #94a3b8;
      text-decoration: none;
      font-size: 14px;
      transition: all 0.2s;
    }

    .nav-item:hover, .nav-item.active {
      color: #f1f5f9;
      background: #334155;
    }

    .sidebar-footer {
      padding: 16px 20px;
      border-top: 1px solid #334155;
    }

    .run-id {
      font-size: 11px;
      color: #64748b;
      word-break: break-all;
    }

    /* Main Content */
    .content {
      flex: 1;
      margin-left: 240px;
      padding: 32px 40px;
      max-width: 1100px;
    }

    .report-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 32px;
    }

    .report-header h1 {
      font-size: 24px;
      font-weight: 700;
      color: #0f172a;
    }

    .timestamp {
      color: #64748b;
      font-size: 13px;
      margin-top: 4px;
    }

    .overall-badge {
      padding: 8px 20px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 14px;
      letter-spacing: 0.5px;
    }

    .overall-badge.passed {
      background: #dcfce7;
      color: #166534;
    }

    .overall-badge.failed {
      background: #fee2e2;
      color: #991b1b;
    }

    /* Section */
    .section {
      margin-bottom: 36px;
    }

    .section h2 {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 16px;
      color: #0f172a;
    }

    /* Summary Cards */
    .summary-cards {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }

    .card {
      background: #fff;
      border-radius: 10px;
      padding: 20px;
      text-align: center;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
      border-top: 4px solid transparent;
    }

    .card-total { border-top-color: #6366f1; }
    .card-passed { border-top-color: #22c55e; }
    .card-failed { border-top-color: #ef4444; }
    .card-skipped { border-top-color: #f59e0b; }

    .card-value {
      font-size: 32px;
      font-weight: 700;
      line-height: 1;
    }

    .card-total .card-value { color: #6366f1; }
    .card-passed .card-value { color: #22c55e; }
    .card-failed .card-value { color: #ef4444; }
    .card-skipped .card-value { color: #f59e0b; }

    .card-label {
      font-size: 13px;
      color: #64748b;
      margin-top: 6px;
      font-weight: 500;
    }

    /* Pass Rate */
    .pass-rate-container {
      background: #fff;
      border-radius: 10px;
      padding: 16px 20px;
      margin-bottom: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    }

    .pass-rate-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 14px;
      font-weight: 500;
    }

    .pass-rate-value { font-weight: 700; color: #0f172a; }

    .progress-bar {
      height: 10px;
      background: #e2e8f0;
      border-radius: 999px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.6s ease;
    }

    .progress-fill.passed { background: linear-gradient(90deg, #22c55e, #16a34a); }
    .progress-fill.failed { background: linear-gradient(90deg, #ef4444, #dc2626); }

    .duration-bar {
      background: #fff;
      border-radius: 10px;
      padding: 12px 20px;
      font-size: 14px;
      color: #475569;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    }

    /* Steps */
    .steps-container {
      background: #fff;
      border-radius: 10px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    }

    .step-item {
      border-bottom: 1px solid #f1f5f9;
    }

    .step-item:last-child { border-bottom: none; }

    .step-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 20px;
      cursor: pointer;
      transition: background 0.15s;
    }

    .step-header:hover { background: #f8fafc; }

    .step-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .step-status-icon {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 700;
      flex-shrink: 0;
    }

    .step-status-icon.passed { background: #dcfce7; color: #166534; }
    .step-status-icon.failed { background: #fee2e2; color: #991b1b; }
    .step-status-icon.skipped { background: #fef3c7; color: #92400e; }

    .step-number {
      font-size: 12px;
      color: #94a3b8;
      font-weight: 600;
      min-width: 30px;
    }

    .step-name {
      font-size: 14px;
      font-weight: 500;
      color: #1e293b;
    }

    .step-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .step-duration {
      font-size: 12px;
      color: #94a3b8;
      font-weight: 500;
    }

    .step-chevron {
      font-size: 14px;
      color: #94a3b8;
      transition: transform 0.2s;
    }

    .step-details {
      padding: 0 20px 16px 64px;
      animation: slideDown 0.2s ease;
    }

    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .step-meta {
      background: #f8fafc;
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 10px;
    }

    .meta-row {
      font-size: 13px;
      margin-bottom: 4px;
      color: #475569;
    }

    .meta-row:last-child { margin-bottom: 0; }

    .meta-label {
      font-weight: 600;
      color: #334155;
    }

    code {
      background: #e2e8f0;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 12px;
      font-family: 'Menlo', 'Consolas', monospace;
    }

    .step-error {
      background: #fef2f2;
      border-left: 3px solid #ef4444;
      padding: 10px 14px;
      border-radius: 4px;
      font-size: 13px;
      color: #991b1b;
      margin-bottom: 10px;
    }

    .step-reason {
      background: #eff6ff;
      border-left: 3px solid #3b82f6;
      padding: 10px 14px;
      border-radius: 4px;
      font-size: 13px;
      color: #1e40af;
      margin-bottom: 10px;
    }

    .step-screenshot img {
      max-width: 100%;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
      cursor: pointer;
      transition: transform 0.3s;
      max-height: 300px;
      object-fit: contain;
    }

    .step-screenshot img.expanded {
      max-height: none;
      transform: scale(1.02);
      box-shadow: 0 8px 30px rgba(0,0,0,0.12);
    }

    /* Console Errors */
    .console-errors h3 {
      font-size: 16px;
      margin-bottom: 12px;
    }

    .error-list {
      background: #1e293b;
      border-radius: 8px;
      padding: 16px;
      max-height: 300px;
      overflow-y: auto;
    }

    .error-item {
      font-family: 'Consolas', monospace;
      font-size: 12px;
      color: #fca5a5;
      margin-bottom: 6px;
      padding: 4px 0;
      border-bottom: 1px solid #334155;
    }

    .error-time { color: #64748b; margin-right: 8px; }

    /* Environment Table */
    .env-table {
      background: #fff;
      border-radius: 10px;
      width: 100%;
      border-collapse: collapse;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
      overflow: hidden;
    }

    .env-table tr { border-bottom: 1px solid #f1f5f9; }
    .env-table tr:last-child { border-bottom: none; }

    .env-table td {
      padding: 12px 20px;
      font-size: 14px;
    }

    .env-table td:first-child {
      font-weight: 600;
      color: #475569;
      width: 160px;
    }

    .env-table a { color: #6366f1; text-decoration: none; }
    .env-table a:hover { text-decoration: underline; }

    .mode-badge {
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 500;
    }

    .mode-badge.exploratory { background: #ede9fe; color: #5b21b6; }
    .mode-badge.scripted { background: #dbeafe; color: #1e40af; }

    .no-steps {
      text-align: center;
      padding: 40px;
      color: #94a3b8;
      font-size: 14px;
    }

    /* Responsive */
    @media (max-width: 900px) {
      .sidebar { display: none; }
      .content { margin-left: 0; padding: 20px; }
      .summary-cards { grid-template-columns: repeat(2, 1fr); }
    }

    /* Report tabs styling */
    .report-tabs {
      display: flex;
      gap: 12px;
      margin-bottom: 24px;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 12px;
    }
    .report-tab-btn {
      padding: 8px 16px;
      border-radius: 6px;
      border: 1px solid #cbd5e1;
      background: #fff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 8px;
      color: #475569;
    }
    .report-tab-btn:hover {
      background: #f8fafc;
      border-color: #94a3b8;
    }
    .report-tab-btn.active {
      border-color: #6366f1;
      background: #eff6ff;
      color: #4f46e5;
    }
    .tab-status-badge {
      font-size: 11px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .tab-status-badge.passed {
      background: #dcfce7;
      color: #166534;
    }
    .tab-status-badge.failed {
      background: #fee2e2;
      color: #991b1b;
    }

    /* Video Player */
    .video-player-container {
      background: #fff;
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 24px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
      border: 1px solid #e2e8f0;
    }
    .video-player-container h3 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 12px;
      color: #0f172a;
    }

    /* Diagnostics Card */
    .diagnostics-card {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-left: 4px solid #f43f5e;
      border-radius: 8px;
      margin-top: 12px;
      margin-bottom: 16px;
      overflow: hidden;
      box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    }
    .diagnostics-header {
      background: #fff5f5;
      padding: 10px 16px;
      border-bottom: 1px solid #fee2e2;
      display: flex;
      align-items: center;
      gap: 8px;
      color: #991b1b;
      font-size: 14px;
    }
    .diagnostics-icon {
      font-size: 16px;
    }
    .diagnostics-body {
      padding: 16px;
    }
    .diag-section {
      margin-bottom: 12px;
    }
    .diag-section:last-child {
      margin-bottom: 0;
    }
    .diag-subtitle {
      display: block;
      font-size: 12px;
      font-weight: 700;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .diag-text {
      font-size: 13.5px;
      line-height: 1.5;
      color: #334155;
    }
    .remediation-list {
      padding-left: 20px;
      font-size: 13.5px;
      line-height: 1.5;
      color: #334155;
    }
    .remediation-list li {
      margin-bottom: 4px;
    }
    .remediation-list li:last-child {
      margin-bottom: 0;
    }

    /* DOM Context Section */
    .dom-context-section {
      border-top: 1px solid #e2e8f0;
    }
    .dom-toggle-btn {
      width: 100%;
      background: #f8fafc;
      border: none;
      padding: 10px 16px;
      text-align: left;
      font-size: 13px;
      font-weight: 600;
      color: #475569;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: background 0.15s;
    }
    .dom-toggle-btn:hover {
      background: #f1f5f9;
    }
    .dom-chevron {
      font-size: 12px;
      color: #94a3b8;
    }
    .dom-context-body {
      padding: 16px;
      background: #1e293b;
      color: #e2e8f0;
      overflow-x: auto;
    }
    .code-header {
      font-size: 11px;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
      margin-top: 10px;
    }
    .code-header:first-child {
      margin-top: 0;
    }
    .dom-context-body pre {
      margin: 0;
      padding: 0;
    }
    .dom-context-body code {
      background: none;
      padding: 0;
      color: #e2e8f0;
      font-size: 12px;
    }
  `;
}

/**
 * Get the JavaScript for the report (collapsible sections)
 */
function getReportJS() {
  return `
    function toggleDomContext(id) {
      const details = document.getElementById('dom-context-' + id);
      const chevron = document.getElementById('dom-chevron-' + id);
      if (details.style.display === 'none') {
        details.style.display = 'block';
        chevron.textContent = '▾';
      } else {
        details.style.display = 'none';
        chevron.textContent = '▸';
      }
    }

    function toggleStep(id) {
      const details = document.getElementById('step-details-' + id);
      const chevron = document.getElementById('chevron-' + id);
      if (details.style.display === 'none') {
        details.style.display = 'block';
        chevron.textContent = '▾';
        chevron.style.transform = 'rotate(0deg)';
      } else {
        details.style.display = 'none';
        chevron.textContent = '▸';
      }
    }

    function showBrowserReport(browser) {
      // Hide all step content areas
      document.querySelectorAll('.browser-steps-content').forEach(el => {
        el.style.display = 'none';
      });
      // Hide all error content areas
      document.querySelectorAll('.browser-errors-content').forEach(el => {
        el.style.display = 'none';
      });

      // Show selected content area
      const stepsTarget = document.getElementById('browser-steps-' + browser);
      if (stepsTarget) stepsTarget.style.display = 'block';
      const errorsTarget = document.getElementById('browser-errors-' + browser);
      if (errorsTarget) errorsTarget.style.display = 'block';

      // Update active state on tab buttons
      document.querySelectorAll('.report-tab-btn').forEach(btn => {
        if (btn.dataset.browser === browser) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
    }

    // Expand all failed steps by default
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('.step-item.failed').forEach(item => {
        const index = item.dataset.stepIndex;
        const details = document.getElementById('step-details-' + index);
        const chevron = document.getElementById('chevron-' + index);
        if (details) {
          details.style.display = 'block';
          chevron.textContent = '▾';
        }
      });

      // Smooth scroll for nav items
      document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
          document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
          e.target.classList.add('active');
        });
      });
    });
  `;
}

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
