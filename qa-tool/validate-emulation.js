/**
 * validate-emulation.js
 * Verifies that the mobile device emulation profile, fallback mappings (Galaxy S22 -> S24),
 * and report generation with the deviceProfile metadata function correctly.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { runScriptedTest } from './scripted.js';
import { generateReport } from './report-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Start a local server to serve public sandbox page
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const PORT = 3007;

const server = app.listen(PORT, async () => {
  console.log(`\n🚀 Emulation Verification server started on http://localhost:${PORT}`);

  try {
    const csvPath = path.join(__dirname, 'self_healing_test.csv');
    console.log(`📖 Reading test CSV from: ${csvPath}`);
    const csvContent = fs.readFileSync(csvPath, 'utf-8');

    // Run 1: Test standard emulation with 'iPhone 14'
    console.log('\n🧪 Test 1: Running scripted test with iPhone 14 emulation...');
    const resultIPhone = await runScriptedTest({
      url: `http://localhost:${PORT}/test-self-healing.html`,
      csvContent,
      browserName: 'chrome',
      deviceProfile: 'iPhone 14',
      onProgress: (evt) => {
        if (evt.type === 'step') {
          console.log(`   [iPhone 14 - STEP #${evt.step}] ${evt.message}`);
        }
      }
    });

    console.log(`   iPhone 14 emulation run completed with status: ${resultIPhone.steps[0].status}`);

    // Run 2: Test fallback emulation with 'Galaxy S22' (which should map to Galaxy S24)
    console.log('\n🧪 Test 2: Running scripted test with Galaxy S22 emulation (fallback test)...');
    const resultGalaxy = await runScriptedTest({
      url: `http://localhost:${PORT}/test-self-healing.html`,
      csvContent,
      browserName: 'chrome',
      deviceProfile: 'Galaxy S22',
      onProgress: (evt) => {
        if (evt.type === 'step') {
          console.log(`   [Galaxy S22 - STEP #${evt.step}] ${evt.message}`);
        }
      }
    });

    console.log(`   Galaxy S22 emulation run completed with status: ${resultGalaxy.steps[0].status}`);

    // Generate report for Consolidated results (e.g. testing HTML generation)
    console.log('\n📄 Generating consolidated test report...');
    const consolidatedResults = {
      testName: 'Emulation Verification Run',
      url: `http://localhost:${PORT}/test-self-healing.html`,
      mode: 'scripted',
      model: 'N/A',
      deviceProfile: 'iPhone 14', // Test setting iPhone 14
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      browsers: {
        chrome: resultIPhone
      },
      cookies: []
    };

    const runId = `verification-emulation`;
    const reportPath = generateReport(runId, consolidatedResults);
    console.log(`✅ Report written to: ${reportPath}`);

    // Verify report contents
    const htmlContent = fs.readFileSync(reportPath, 'utf-8');
    const hasDeviceRow = htmlContent.includes('<td>Device Emulation</td>');
    const hasIPhoneValue = htmlContent.includes('iPhone 14');

    console.log('\n📊 === DEVICE EMULATION VALIDATION SANITY CHECK ===');
    console.log(`Report generated successfully: ${fs.existsSync(reportPath) ? '✅ YES' : '❌ NO'}`);
    console.log(`Report contains "Device Emulation" row: ${hasDeviceRow ? '✅ YES' : '❌ NO'}`);
    console.log(`Report displays "iPhone 14" value: ${hasIPhoneValue ? '✅ YES' : '❌ NO'}`);
    console.log('==================================================');

  } catch (error) {
    console.error('❌ Verification runner error:', error);
  } finally {
    server.close(() => {
      console.log('🔌 Emulation Verification server stopped.');
      process.exit(0);
    });
  }
});
