/**
 * verify-failure.js
 * Programmatically runs the failing validation CSV test case,
 * prints execution details showing the failure diagnostics,
 * and generates the report with video.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { runScriptedTest } from './scripted.js';
import { generateReport } from './report-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  try {
    const csvPath = path.join(__dirname, 'validation_failure.csv');
    console.log(`📖 Reading test CSV from: ${csvPath}`);
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    
    const runId = `verification-failure-${Date.now()}`;
    console.log(`🧪 Running scripted test with run ID: ${runId}`);
    
    const results = await runScriptedTest({
      url: `https://the-internet.herokuapp.com/login`,
      csvContent,
      runId,
      model: 'qwen2.5-coder:7b',
      ollamaUrl: 'http://127.0.0.1:11434',
      onProgress: (evt) => {
        if (evt.type === 'step') {
          console.log(`   [STEP #${evt.step}] ${evt.message}`);
        } else if (evt.type === 'step-result') {
          const statusIcon = evt.status === 'passed' ? '✅' : '❌';
          console.log(`   [RESULT #${evt.step}] ${statusIcon} Status: ${evt.status}`);
        } else if (evt.type === 'status') {
          console.log(`   [STATUS] ${evt.message}`);
        } else if (evt.type === 'info') {
          console.log(`   [INFO] ${evt.message}`);
        }
      }
    });

    console.log('\n📄 Generating test report...');
    const reportPath = generateReport(runId, results);
    console.log(`✅ Report written to: ${reportPath}`);

    console.log('\n📊 === DIAGNOSTICS FOR FAILED STEP ===');
    results.steps.forEach((step, idx) => {
      if (step.status === 'failed') {
        console.log(`\nFailed Step #${idx + 1}: ${step.name}`);
        console.log(`  Error: ${step.error}`);
        if (step.diagnostics) {
          console.log(`  URL: ${step.diagnostics.url}`);
          console.log(`  Title: ${step.diagnostics.title}`);
          console.log(`  DOM Snippet:\n${step.diagnostics.elementHtml || 'N/A'}`);
          console.log(`  AI Analysis:`);
          console.log(JSON.stringify(step.diagnostics.aiAnalysis, null, 2));
        } else {
          console.log('  Diagnostics object was not generated.');
        }
      }
    });
    console.log('\n======================================');

  } catch (error) {
    console.error('❌ Verification script error:', error);
  }
}

run();
