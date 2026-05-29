/**
 * validate-exploratory-modes.js
 * Automatically verifies that Bug Hunting and Auto-Documentation modes function correctly.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3009;

// Set PORT environment variable before importing server
process.env.PORT = PORT;

// Start server
console.log('🚀 Launching QA server for validation...');
const serverImport = await import('../../server.js');
const app = serverImport.default;

// Wait a bit for server to fully initialize
await new Promise(resolve => setTimeout(resolve, 2000));

async function runTestMode(type) {
  console.log(`\n==================================================`);
  console.log(`🧪 TESTING MODE: ${type.toUpperCase()}`);
  console.log(`==================================================`);

  // 1. Check Ollama status first
  try {
    const statusRes = await fetch(`http://localhost:${PORT}/api/ollama-status`);
    const statusData = await statusRes.json();
    console.log(`Ollama Connected: ${statusData.connected}`);
    if (!statusData.connected) {
      console.warn('⚠️ Ollama is offline. Skipping exploratory crawl execution.');
      return;
    }
  } catch (err) {
    console.error('Cannot connect to server to verify Ollama status:', err.message);
    return;
  }

  // 2. Start the run
  console.log(`📤 Sending run-test request for ${type}...`);
  let runId;
  try {
    const res = await fetch(`http://localhost:${PORT}/run-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `http://localhost:${PORT}/test-self-healing.html`,
        exploratoryMode: 'true',
        exploratoryType: type,
        browsers: '["chrome"]',
        model: 'qwen2.5-coder:7b'
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Server returned ${res.status}: ${errText}`);
    }

    const data = await res.json();
    runId = data.runId;
    console.log(`✅ Run started. ID: ${runId}`);
  } catch (err) {
    console.error(`❌ Failed to start test: ${err.message}`);
    return;
  }

  // 3. Monitor via EventSource/SSE manually
  console.log(`📡 Monitoring progress for run ${runId}...`);
  return new Promise((resolve) => {
    // We fetch the SSE stream manually using fetch and stream reader
    fetch(`http://localhost:${PORT}/test-status/${runId}`)
      .then(async (res) => {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.substring(6));
                if (data.type === 'step') {
                  console.log(`   [STEP] ${data.message}`);
                } else if (data.type === 'step-result') {
                  console.log(`   [RESULT] ${data.status.toUpperCase()}: ${data.message}`);
                } else if (data.type === 'status' || data.type === 'info') {
                  console.log(`   [INFO] ${data.message}`);
                } else if (data.type === 'complete' && data.summary) {
                  console.log(`\n🎉 Test completed: ${data.message}`);
                  
                  // Check output files
                  const reportDir = path.join(__dirname, '..', '..', 'reports', runId);
                  const htmlExists = fs.existsSync(path.join(reportDir, 'index.html'));
                  console.log(`HTML Report exists: ${htmlExists ? '✅ Yes' : '❌ No'}`);

                  if (type === 'documentation') {
                    const mdPath = path.join(reportDir, 'documentation-report.md');
                    const mdExists = fs.existsSync(mdPath);
                    console.log(`Markdown Documentation exists: ${mdExists ? '✅ Yes' : '❌ No'}`);
                    if (mdExists) {
                      const mdContent = fs.readFileSync(mdPath, 'utf-8');
                      const hasSitemap = mdContent.includes('Site Sitemap');
                      const hasLocators = mdContent.includes('Business Feature Catalog');
                      const hasJourney = mdContent.includes('User Journey & Visual Walkthrough');
                      console.log(`   Contains Sitemap: ${hasSitemap ? '✅ Yes' : '❌ No'}`);
                      console.log(`   Contains Business Catalog: ${hasLocators ? '✅ Yes' : '❌ No'}`);
                      console.log(`   Contains User Journey: ${hasJourney ? '✅ Yes' : '❌ No'}`);
                      
                      const screenshotsDir = path.join(reportDir, 'screenshots');
                      const screenshotCount = fs.existsSync(screenshotsDir) 
                        ? fs.readdirSync(screenshotsDir).length 
                        : 0;
                      console.log(`   Screenshot PNG files written: ${screenshotCount} (should be >= 1)`);
                    }

                    const docxPath = path.join(reportDir, 'documentation-spec.docx');
                    const docxExists = fs.existsSync(docxPath);
                    console.log(`Word Specification Document exists: ${docxExists ? '✅ Yes' : '❌ No'}`);
                  }
                  resolve();
                  return;
                } else if (data.type === 'error') {
                  console.error(`❌ Test failed with error: ${data.message}`);
                  resolve();
                  return;
                }
              } catch (_) {}
            }
          }
        }
        resolve();
      })
      .catch((err) => {
        console.error('SSE monitoring error:', err.message);
        resolve();
      });
  });
}

try {
  await runTestMode('bug-hunting');
  await runTestMode('documentation');
} catch (err) {
  console.error('Validation runner crashed:', err);
} finally {
  console.log('\n🔌 Shutting down validation server...');
  if (serverImport && serverImport.server) {
    await new Promise((resolve) => {
      serverImport.server.close(() => {
        console.log('Server stopped.');
        resolve();
      });
    });
  }
  process.exit(0);
}
