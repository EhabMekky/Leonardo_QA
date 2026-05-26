import { chromium } from 'playwright';
import { executeInteraction } from './interaction-helper.js';
import fs from 'fs';
import path from 'path';

async function test() {
  console.log('🚀 Launching browser...');
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();

  console.log('🌐 Navigating to https://bitheap.tech/...');
  await page.goto('https://bitheap.tech/', { waitUntil: 'domcontentloaded' });
  
  console.log('⏳ Waiting 5 seconds for page load and any banners...');
  await page.waitForTimeout(5000);

  // Take initial screenshot
  await page.screenshot({ path: './reports/before_click.png' });
  console.log('📸 Saved screenshot before_click.png');

  console.log('🎯 Executing interaction click on "Login"...');
  const result = await executeInteraction(page, 'click', 'Login', '', 10000);
  console.log('📊 Result of executeInteraction:', JSON.stringify(result, null, 2));

  // Take final screenshot
  await page.screenshot({ path: './reports/after_click.png' });
  console.log('📸 Saved screenshot after_click.png');

  await browser.close();
}

test().catch(console.error);
