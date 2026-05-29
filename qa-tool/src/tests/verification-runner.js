/**
 * verification-runner.js
 * Programmatically starts a local server, runs the self-healing test CSV,
 * prints execution details showing healing strategies, and generates the report.
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
const PORT = 3005;

const server = app.listen(PORT, async () => {
  console.log(`\n🚀 Verification server started on http://localhost:${PORT}`);

  try {
    const csvPath = path.join(__dirname, '..', '..', 'data', 'self_healing_test.csv');
    console.log(`📖 Reading test CSV from: ${csvPath}`);
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    
    console.log('🧪 Running scripted test with self-healing...');
    const results = await runScriptedTest({
      url: `http://localhost:${PORT}/test-self-healing.html`,
      csvContent,
      onProgress: (evt) => {
        if (evt.type === 'step') {
          console.log(`   [STEP #${evt.step}] ${evt.message}`);
        } else if (evt.type === 'step-result') {
          const statusIcon = evt.status === 'passed' ? '✅' : '❌';
          console.log(`   [RESULT #${evt.step}] ${statusIcon} Status: ${evt.status}`);
        }
      }
    });

    console.log('\n📄 Generating test report...');
    const runId = `verification-self-healing`;
    const reportPath = generateReport(runId, results);
    console.log(`✅ Report written to: ${reportPath}`);

    console.log('\n📊 === SELF-HEALING TEST RESULTS ===');
    results.steps.forEach((step, idx) => {
      console.log(`\nStep #${idx + 1}: ${step.name}`);
      console.log(`  Action:   ${step.action}`);
      console.log(`  Selector: ${step.selector || 'N/A'}`);
      console.log(`  Value:    ${step.value || 'N/A'}`);
      console.log(`  Status:   ${step.status.toUpperCase()}`);
      if (step.reason) {
        console.log(`  Details:  \x1b[32m${step.reason}\x1b[0m`);
      }
      if (step.error) {
        console.log(`  Error:    \x1b[31m${step.error}\x1b[0m`);
      }
    });
    console.log('\n=====================================');

  } catch (error) {
    console.error('❌ Verification runner error:', error);
  } finally {
    server.close(() => {
      console.log('🔌 Verification server stopped.');
      process.exit(0);
    });
  }
});
