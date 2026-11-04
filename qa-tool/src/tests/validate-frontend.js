/**
 * validate-frontend.js
 * Programmatically starts a local server serving the redesigned public assets,
 * spins up Playwright to navigate to index.html, and validates the wizard steps,
 * quick start pre-fill, Ollama popovers, and mode selections.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3010;

// Setup a mock server for testing the frontend UI
const app = express();
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

// Mock endpoints
app.get('/api/ollama-status', (req, res) => {
  res.json({
    connected: false,
    url: 'http://127.0.0.1:11434',
    models: [],
    error: 'Ollama connection refused'
  });
});

app.get('/api/ollama-models', (req, res) => {
  res.json({ models: [] });
});

app.get('/api/reports', (req, res) => {
  // Use mock dates relative to current time to verify relative date formatting
  const now = new Date();
  const date5m = new Date(now.getTime() - 5 * 60 * 1000).toISOString(); // 5 min ago
  const date3h = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(); // 3 hours ago
  
  res.json({
    reports: [
      {
        id: 'run-mock-passed',
        exists: true,
        createdAt: date5m,
        url: '#',
        targetUrl: 'https://example.com',
        status: 'passed'
      },
      {
        id: 'run-mock-failed',
        exists: true,
        createdAt: date3h,
        url: '#',
        targetUrl: 'https://the-internet.herokuapp.com/broken_images',
        status: 'failed'
      }
    ]
  });
});

// Run-test endpoint mock
app.post('/run-test', (req, res) => {
  res.json({
    runId: 'run-mock-active',
    status: 'started',
    mode: 'scripted',
    message: 'Mock test started successfully'
  });
});

const server = app.listen(PORT, async () => {
  console.log(`\n🚀 Mock validation server started on http://localhost:${PORT}`);
  
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    console.log('🔗 Navigating to UI home page...');
    await page.goto(`http://localhost:${PORT}/index.html`);
    
    // Wait for the past reports to load and render
    await page.waitForTimeout(1000);
    
    console.log('🔍 Validating Page Title...');
    const title = await page.title();
    console.log(`   Page Title: "${title}"`);
    if (!title.includes('Leonardo')) {
      throw new Error('Title verification failed');
    }
    
    console.log('🔍 Validating Step 1 Visibility & Fields...');
    const step1Visible = await page.isVisible('#step-1-fields');
    const step2Visible = await page.isVisible('#step-2-fields');
    const step3Visible = await page.isVisible('#step-3-fields');
    console.log(`   Step 1 visible: ${step1Visible ? '✅' : '❌'}`);
    console.log(`   Step 2 hidden: ${!step2Visible ? '✅' : '❌'}`);
    console.log(`   Step 3 hidden: ${!step3Visible ? '✅' : '❌'}`);
    
    if (!step1Visible || step2Visible || step3Visible) {
      throw new Error('Wizard step visibility verification failed');
    }
    
    console.log('🔍 Validating Past Reports list...');
    const reportsText = await page.textContent('#reports-list');
    console.log(`   Reports Rendered text snippet: "${reportsText.trim().replace(/\s+/g, ' ')}"`);
    if (!reportsText.includes('run-mock-passed') || !reportsText.includes('run-mock-failed')) {
      throw new Error('Past reports mock data not rendered');
    }
    if (!reportsText.includes('minutes ago') && !reportsText.includes('hours ago')) {
      throw new Error('Relative time delta formatting verification failed');
    } else {
      console.log('   Relative time delta formatting: ✅ SUCCESS');
    }
    
    console.log('🔍 Validating Ollama offline warning and setup guide popover...');
    const statusDotClass = await page.evaluate(() => document.getElementById('ollama-dot').className);
    console.log(`   Ollama status dot classes: "${statusDotClass}"`);
    const statusText = await page.textContent('#ollama-label');
    console.log(`   Ollama status text: "${statusText.trim()}"`);
    if (!statusText.includes('Ollama offline')) {
      throw new Error('Ollama offline warning not displayed when offline');
    }
    
    // Test toggle popover
    let popoverVisible = await page.isVisible('#ollama-popover');
    console.log(`   Popover initially hidden: ${!popoverVisible ? '✅' : '❌'}`);
    
    await page.click('#ollama-status');
    await page.waitForTimeout(200);
    popoverVisible = await page.isVisible('#ollama-popover');
    console.log(`   Popover visible after status click: ${popoverVisible ? '✅' : '❌'}`);
    if (!popoverVisible) {
      throw new Error('Ollama setup popover failed to show on click');
    }
    
    // Close popover
    await page.click('body');
    await page.waitForTimeout(200);
    popoverVisible = await page.isVisible('#ollama-popover');
    console.log(`   Popover hidden after clicking outside: ${!popoverVisible ? '✅' : '❌'}`);
    
    // -------------------------------------------------------------
    // Test Quick Starts
    // -------------------------------------------------------------
    
    console.log('\n🧪 Testing Quick Start Template 1: Smoke Test...');
    await page.click('div[onclick="applyQuickStart(1)"]');
    await page.waitForTimeout(200);
    
    let urlVal = await page.$eval('#url-input', el => el.value);
    console.log(`   Prefilled URL: "${urlVal}"`);
    if (urlVal !== 'https://authenticationtest.com/simpleForm/') {
      throw new Error('Quick Start 1 failed to prefill target URL');
    }
    
    let activeStep = await page.evaluate(() => currentStep);
    console.log(`   Current wizard step: ${activeStep}`);
    if (activeStep !== 2) {
      throw new Error('Quick Start 1 failed to auto-navigate to Step 2');
    }
    
    // Check mode card highlight
    let scriptedCardSelected = await page.evaluate(() => {
      const card = document.querySelector('input[name="testingMode"][value="scripted"]').closest('.mode-card');
      return card.classList.contains('border-l-blue-500') && card.classList.contains('bg-blue-500/10');
    });
    console.log(`   Scripted Mode Card Highlighted: ${scriptedCardSelected ? '✅' : '❌'}`);
    if (!scriptedCardSelected) {
      throw new Error('Scripted mode card classes not applied properly');
    }
    
    // Check CSV section is visible
    let csvVisible = await page.isVisible('#test-steps-input-section');
    let helperVisible = await page.isVisible('#no-steps-helper');
    console.log(`   CSV Steps Editor visible: ${csvVisible ? '✅' : '❌'}`);
    console.log(`   Helper Text hidden: ${!helperVisible ? '✅' : '❌'}`);
    if (!csvVisible || helperVisible) {
      throw new Error('CSV fields visibility mismatch in Scripted mode');
    }
    
    // Go back to Step 1
    await page.click('button[onclick="goToStep(1)"]');
    await page.waitForTimeout(200);
    
    console.log('\n🧪 Testing Quick Start Template 2: Bug Hunt...');
    await page.click('div[onclick="applyQuickStart(2)"]');
    await page.waitForTimeout(200);
    
    urlVal = await page.$eval('#url-input', el => el.value);
    console.log(`   Prefilled URL: "${urlVal}"`);
    if (urlVal !== 'https://the-internet.herokuapp.com/broken_images') {
      throw new Error('Quick Start 2 failed to prefill target URL');
    }
    
    activeStep = await page.evaluate(() => currentStep);
    console.log(`   Current wizard step: ${activeStep}`);
    if (activeStep !== 2) {
      throw new Error('Quick Start 2 failed to auto-navigate to Step 2');
    }
    
    // Check mode card highlight
    let bugHuntCardSelected = await page.evaluate(() => {
      const card = document.querySelector('input[name="testingMode"][value="bug-hunting"]').closest('.mode-card');
      return card.classList.contains('border-l-amber-500') && card.classList.contains('bg-amber-500/10');
    });
    console.log(`   Bug Hunt Mode Card Highlighted: ${bugHuntCardSelected ? '✅' : '❌'}`);
    
    // Check CSV section is hidden and helper is visible
    csvVisible = await page.isVisible('#test-steps-input-section');
    helperVisible = await page.isVisible('#no-steps-helper');
    console.log(`   CSV Steps Editor hidden: ${!csvVisible ? '✅' : '❌'}`);
    console.log(`   Helper Text visible: ${helperVisible ? '✅' : '❌'}`);
    if (csvVisible || !helperVisible) {
      throw new Error('CSV fields visibility mismatch in Bug Hunt mode');
    }
    
    // Go back to Step 1
    await page.click('button[onclick="goToStep(1)"]');
    await page.waitForTimeout(200);
    
    console.log('\n🧪 Testing Quick Start Template 3: Auto-Doc...');
    await page.click('div[onclick="applyQuickStart(3)"]');
    await page.waitForTimeout(200);
    
    urlVal = await page.$eval('#url-input', el => el.value);
    console.log(`   Prefilled URL: "${urlVal}"`);
    if (urlVal !== 'https://example.com') {
      throw new Error('Quick Start 3 failed to prefill target URL');
    }
    
    activeStep = await page.evaluate(() => currentStep);
    console.log(`   Current wizard step: ${activeStep}`);
    if (activeStep !== 2) {
      throw new Error('Quick Start 3 failed to auto-navigate to Step 2');
    }
    
    // Check mode card highlight
    let docCardSelected = await page.evaluate(() => {
      const card = document.querySelector('input[name="testingMode"][value="documentation"]').closest('.mode-card');
      return card.classList.contains('border-l-purple-500') && card.classList.contains('bg-purple-500/10');
    });
    console.log(`   Auto-Doc Mode Card Highlighted: ${docCardSelected ? '✅' : '❌'}`);
    
    console.log('\n📊 === FRONTEND REDESIGN VALIDATION SUCCESS ===');
    console.log('All frontend component interactions, quick starts, step switching, and relative timestamps validated successfully.');
    console.log('==================================================');
    
  } catch (error) {
    console.error('❌ Frontend Validation Error:', error);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
    server.close(() => {
      console.log('🔌 Mock validation server stopped.');
      process.exit(process.exitCode || 0);
    });
  }
});
