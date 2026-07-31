/**
 * accessibility.js — Axe-core Automated Accessibility Auditor
 * 
 * Runs automated accessibility checks using @axe-core/playwright.
 * Verifies WCAG 2.1 A/AA compliance + best practices.
 * 
 * Supports:
 * - Launching Playwright browser (Chrome, Firefox, Edge)
 * - Navigation and load status handling
 * - Static page scanning
 * - Dynamic element state scanning (clicks on dropdowns, accordion triggers, etc.)
 * - Consolidating violations into clean structured format
 * - Capturing screenshots and progress SSE streaming
 */

import { chromium, firefox, devices } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTION_TIMEOUT_MS = 10000;

/**
 * Run accessibility scan
 * @param {Object} options - Test options
 * @param {string} options.url - Target URL to scan
 * @param {Array} options.cookies - Cookies to inject
 * @param {string} options.runId - Run identifier
 * @param {Function} options.onProgress - SSE progress stream callback
 * @param {Object} options.signal - Abort signal
 * @param {string} options.browserName - Target browser
 * @param {string} options.deviceProfile - Mobile emulation profile or desktop
 */
export async function runAccessibilityTest(options) {
  const {
    url,
    cookies = [],
    model = 'N/A',
    ollamaUrl = 'http://127.0.0.1:11434',
    runId,
    onProgress = () => {},
    signal,
    browserName = 'chrome',
    deviceProfile = 'desktop'
  } = options;

  const startTime = new Date();
  const consoleErrors = [];
  let browser = null;
  let context = null;
  let page = null;

  const abortHandler = async () => {
    onProgress({ type: 'status', message: 'Test cancelled by user.' });
    if (page) {
      try { await page.close(); } catch (_) {}
    }
    if (context) {
      try { await context.close(); } catch (_) {}
    }
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  };

  if (signal) {
    if (signal.aborted) {
      throw new Error('Test run cancelled by user');
    }
    signal.addEventListener('abort', abortHandler);
  }

  try {
    // --- Launch Browser ---
    onProgress({ type: 'status', message: `Launching browser ${browserName}...` });
    if (browserName === 'firefox') {
      browser = await firefox.launch({
        headless: false,
        slowMo: 300
      });
    } else if (browserName === 'edge') {
      browser = await chromium.launch({
        headless: false,
        slowMo: 300,
        channel: 'msedge'
      });
    } else {
      browser = await chromium.launch({
        headless: false,
        slowMo: 300
      });
    }

    const contextOptions = {
      viewport: { width: 1280, height: 720 }
    };

    if (deviceProfile && deviceProfile !== 'desktop') {
      let profileName = deviceProfile;
      if (profileName === 'Galaxy S22' && !devices[profileName]) {
        profileName = 'Galaxy S24';
      }
      const deviceConfig = devices[profileName] || {};
      Object.assign(contextOptions, deviceConfig);
    }

    context = await browser.newContext(contextOptions);

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
    onProgress({ type: 'status', message: `Connecting to ${url}...` });
    const navStart = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
    
    // Wait for network settle
    onProgress({ type: 'info', message: 'Page loaded. Settle wait...' });
    try {
      await page.waitForLoadState('networkidle', { timeout: 3000 });
    } catch (_) {
      // Ignore networkidle timeout, proceed
    }

    // --- Run Static Audit ---
    onProgress({ type: 'status', message: 'Running accessibility rule checks (WCAG A/AA + Best Practices)...' });
    
    const staticScan = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
      .analyze();
      
    const staticViolations = staticScan.violations || [];
    onProgress({ type: 'info', message: `Static audit complete. Found ${staticViolations.length} violation rules.` });

    // --- Scan Dynamic Elements ---
    onProgress({ type: 'status', message: 'Scanning dynamic elements (expandable panels, accordion toggles, dropdowns)...' });
    
    const dynamicViolations = [];
    try {
      // Check for visible buttons/toggles that expand content
      const selectors = [
        'button[aria-expanded="false"]',
        '[class*="accordion"] button',
        '[class*="dropdown"] button',
        '[class*="toggle"]',
        '.accordion-trigger',
        '.dropdown-trigger'
      ];
      
      const elementsToTry = [];
      for (const selector of selectors) {
        const handles = await page.$$(selector);
        for (const handle of handles) {
          if (await handle.isVisible()) {
            elementsToTry.push({ handle, selector });
          }
        }
      }
      
      if (elementsToTry.length > 0) {
        onProgress({ type: 'info', message: `Discovered ${elementsToTry.length} dynamic triggers. Testing state updates...` });
        const maxClicks = Math.min(3, elementsToTry.length);
        for (let i = 0; i < maxClicks; i++) {
          const { handle, selector } = elementsToTry[i];
          try {
            onProgress({ type: 'info', message: `Clicking dynamic component to reveal hidden elements: ${selector}` });
            await handle.click({ timeout: 2000 });
            await page.waitForTimeout(600); // Allow animations/draws
            
            const dynamicScan = await new AxeBuilder({ page })
              .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
              .analyze();
              
            if (dynamicScan.violations) {
              dynamicViolations.push(...dynamicScan.violations);
            }
          } catch (clickErr) {
            console.warn(`Could not interact with trigger ${selector}:`, clickErr.message);
          }
        }
      } else {
        onProgress({ type: 'info', message: 'No hidden dynamic panels or accordion triggers detected.' });
      }
    } catch (dynamicErr) {
      console.warn('Error during dynamic state scans:', dynamicErr);
    }

    // --- Merge Violations ---
    const allViolationsMap = new Map();
    
    const addViolations = (violationsList, isDynamic = false) => {
      for (const v of violationsList) {
        if (!allViolationsMap.has(v.id)) {
          allViolationsMap.set(v.id, {
            id: v.id,
            impact: v.impact || 'minor',
            description: v.description,
            help: v.help,
            helpUrl: v.helpUrl,
            nodes: []
          });
        }
        
        const ruleEntry = allViolationsMap.get(v.id);
        for (const node of v.nodes) {
          const targetStr = node.target.join(', ');
          const nodeExists = ruleEntry.nodes.some(n => n.target === targetStr);
          if (!nodeExists) {
            ruleEntry.nodes.push({
              target: targetStr,
              html: node.html,
              failureSummary: node.failureSummary,
              isDynamic
            });
          }
        }
      }
    };

    addViolations(staticViolations, false);
    addViolations(dynamicViolations, true);

    const mergedViolations = Array.from(allViolationsMap.values()).filter(v => v.nodes.length > 0);
    
    // --- Capture Page Snapshot ---
    onProgress({ type: 'status', message: 'Capturing final page screenshot...' });
    const screenshot = await captureScreenshot(page);

    onProgress({ type: 'status', message: 'Packaging results...' });
    await page.waitForTimeout(500);

    const totalOccurrences = mergedViolations.reduce((acc, v) => acc + v.nodes.length, 0);

    const steps = [
      {
        name: `Navigate to ${url}`,
        action: 'navigate',
        selector: '',
        value: url,
        status: 'passed',
        duration: Date.now() - navStart,
        error: null,
        screenshot,
        reason: 'Successfully reached and loaded target website.'
      },
      {
        name: `Axe Accessibility Scan`,
        action: 'accessibility-scan',
        selector: '',
        value: `${mergedViolations.length} rules violated`,
        status: mergedViolations.length === 0 ? 'passed' : 'failed',
        duration: Date.now() - startTime,
        error: mergedViolations.length === 0 ? null : `${mergedViolations.length} accessibility violation rules detected`,
        screenshot,
        reason: `Scan complete. Discovered ${totalOccurrences} occurrences across ${mergedViolations.length} distinct rule failures.`
      }
    ];

    const results = {
      testName: 'Accessibility Scan',
      url,
      mode: 'accessibility',
      startTime: startTime.toISOString(),
      endTime: new Date().toISOString(),
      steps,
      violations: mergedViolations,
      consoleErrors,
      cookies
    };

    onProgress({ type: 'complete', message: 'Accessibility scan execution complete', results });
    return results;

  } catch (error) {
    onProgress({ type: 'error', message: `Accessibility Scan failed: ${error.message}` });
    const steps = [
      {
        name: 'Accessibility Scan Failure',
        action: 'system',
        selector: '',
        value: '',
        status: 'failed',
        duration: 0,
        error: error.message,
        screenshot: null,
        reason: ''
      }
    ];
    return {
      testName: 'Accessibility Scan',
      url,
      mode: 'accessibility',
      startTime: startTime.toISOString(),
      endTime: new Date().toISOString(),
      steps,
      violations: [],
      consoleErrors,
      cookies
    };
  } finally {
    if (signal) {
      signal.removeEventListener('abort', abortHandler);
    }
    if (page) {
      try { await page.close(); } catch (_) {}
    }
    if (context) {
      try { await context.close(); } catch (_) {}
    }
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
}

/**
 * Capture screenshot
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
