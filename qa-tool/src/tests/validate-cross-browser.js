/**
 * validate-cross-browser.js
 * Verifies that the cross-browser test execution, log segmentation,
 * and multi-browser report compilation function correctly.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { runScriptedTest } from '../engines/scripted.js';
import { generateReport } from '../utils/report-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Start a local server to serve public sandbox page
const app = express();
app.use(express.static(path.join(__dirname, '..', '..', 'public')));
const PORT = 3006;

const server = app.listen(PORT, async () => {
  console.log(`\n🚀 Verification server started on http://localhost:${PORT}`);

  try {
    const csvPath = path.join(__dirname, '..', '..', 'data', 'self_healing_test.csv');
    console.log(`📖 Reading test CSV from: ${csvPath}`);
    const csvContent = fs.readFileSync(csvPath, 'utf-8');

    // We will verify execution across 'chrome' and 'firefox' (and 'edge' if installed)
    const targetBrowsers = ['chrome', 'firefox'];
    console.log(`🧪 Running cross-browser tests concurrently on: ${targetBrowsers.join(', ')}`);

    const resultsByBrowser = {};
    const startTime = new Date();

    const runnerPromises = targetBrowsers.map(async (browserName) => {
      try {
        console.log(`   [${browserName.toUpperCase()}] Starting test run...`);
        const runResult = await runScriptedTest({
          url: `http://localhost:${PORT}/test-self-healing.html`,
          csvContent,
          browserName,
          onProgress: (evt) => {
            if (evt.type === 'step') {
              console.log(`   [${browserName.toUpperCase()} - STEP #${evt.step}] ${evt.message}`);
            } else if (evt.type === 'step-result') {
              const statusIcon = evt.status === 'passed' ? '✅' : '❌';
              console.log(`   [${browserName.toUpperCase()} - RESULT #${evt.step}] ${statusIcon} Status: ${evt.status}`);
            }
          }
        });
        resultsByBrowser[browserName] = runResult;
        console.log(`   [${browserName.toUpperCase()}] Test run complete.`);
      } catch (err) {
        console.warn(`   [${browserName.toUpperCase()}] Run failed or browser not installed: ${err.message}`);
        // Fallback for verification run failure
        resultsByBrowser[browserName] = {
          testName: 'Scripted Test (CSV)',
          url: `http://localhost:${PORT}/test-self-healing.html`,
          mode: 'scripted',
          model: 'N/A',
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
              error: err.message,
              screenshot: null,
              reason: `Failed to launch or execute: ${err.message}`
            }
          ],
          consoleErrors: [],
          cookies: []
        };
      }
    });

    await Promise.all(runnerPromises);

    console.log('\n📄 Generating consolidated multi-browser report...');
    const consolidatedResults = {
      testName: 'Cross-Browser Verification Run',
      url: `http://localhost:${PORT}/test-self-healing.html`,
      mode: 'scripted',
      model: 'N/A',
      startTime: startTime.toISOString(),
      endTime: new Date().toISOString(),
      browsers: resultsByBrowser,
      cookies: []
    };

    const runId = `verification-cross-browser`;
    const reportPath = generateReport(runId, consolidatedResults);
    console.log(`✅ Report written to: ${reportPath}`);

    // Verify report contents
    const htmlContent = fs.readFileSync(reportPath, 'utf-8');
    const hasTabsClass = htmlContent.includes('class="report-tabs"');
    const hasActiveBrowsersLabel = htmlContent.includes('Active Browsers');
    const hasTabBtn = htmlContent.includes('report-tab-btn');

    console.log('\n📊 === CROSS-BROWSER VALIDATION SANITY CHECK ===');
    console.log(`Report generated successfully: ${fs.existsSync(reportPath) ? '✅ YES' : '❌ NO'}`);
    console.log(`Report contains tab switcher: ${hasTabsClass ? '✅ YES' : '❌ NO'}`);
    console.log(`Report has active browsers in environment list: ${hasActiveBrowsersLabel ? '✅ YES' : '❌ NO'}`);
    console.log(`Report has tab buttons: ${hasTabBtn ? '✅ YES' : '❌ NO'}`);
    console.log('==================================================');

  } catch (error) {
    console.error('❌ Verification runner error:', error);
  } finally {
    server.close(() => {
      console.log('🔌 Verification server stopped.');
      process.exit(0);
    });
  }
});
