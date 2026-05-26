/**
 * interaction-helper.js - Self-Healing and Robust Playwright Interactions
 * 
 * Provides a wrapper for Playwright page actions (click, fill, scroll)
 * that automatically detects element interaction failures, applies
 * self-healing selector strategies (text, XPath, fuzzy DOM matching,
 * parent/label coordinates), and bypasses overlapping element obstructions.
 */



/**
 * Execute a page action with self-healing capabilities
 * @param {import('playwright').Page} page - Playwright page object
 * @param {string} action - 'click', 'fill', 'scroll'
 * @param {string} selector - CSS or other locator string
 * @param {string} value - Text input value (for fill) or options
 * @param {number} timeoutMs - Max timeout for each locator check (default: 8000ms)
 * @returns {Promise<Object>} { status: 'passed'|'failed', error: string|null, healed: boolean, healMethod: string|null, resolvedSelector: string|null }
 */
export async function executeInteraction(page, action, selector, value = '', timeoutMs = 8000) {
  action = action.toLowerCase().trim();
  let lastError = null;

  console.log(`[Interaction] Attempting ${action} on "${selector}"...`);

  // ==========================================================================
  // STRATEGY 1: Standard Playwright Selector Action
  // ==========================================================================
  try {
    switch (action) {
      case 'click':
        await page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });
        await page.locator(selector).first().click({ timeout: timeoutMs });
        return { status: 'passed', error: null, healed: false, healMethod: null, resolvedSelector: selector };

      case 'fill':
        await page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });
        await page.locator(selector).first().clear({ timeout: timeoutMs });
        await page.locator(selector).first().fill(value, { timeout: timeoutMs });
        return { status: 'passed', error: null, healed: false, healMethod: null, resolvedSelector: selector };

      case 'scroll':
        if (selector) {
          await page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });
          await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: timeoutMs });
        } else {
          await page.evaluate(() => window.scrollBy(0, 400));
        }
        return { status: 'passed', error: null, healed: false, healMethod: null, resolvedSelector: selector || 'window' };

      default:
        throw new Error(`Unsupported action in helper: ${action}`);
    }
  } catch (err) {
    lastError = err;
    console.warn(`⚠️ Strategy 1 (Standard) failed for ${action} on "${selector}": ${err.message}`);
  }

  // ==========================================================================
  // STRATEGY 1.5: Wait for Modal Animation, then Dynamic Overlay/Modal Closure & Retry
  // ==========================================================================
  // If Strategy 1 failed, first check if the element might be animating into view
  // (e.g. a modal was just opened by the previous step). Wait up to 3s before
  // running overlay detection so we don't accidentally dismiss a modal that
  // contains the target element.
  try {
    console.log(`[Self-Healing] Strategy 1 failed for "${selector}". Waiting for element to appear (modal animation)...`);
    const appearedAfterWait = await page.waitForSelector(selector, { state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false);

    if (appearedAfterWait) {
      console.log(`[Self-Healing] Element appeared after waiting. Retrying standard action...`);
      switch (action) {
        case 'click':
          await page.locator(selector).first().click({ timeout: 5000 });
          break;
        case 'fill':
          await page.locator(selector).first().clear({ timeout: 5000 });
          await page.locator(selector).first().fill(value, { timeout: 5000 });
          break;
        case 'scroll':
          if (selector) {
            await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 5000 });
          } else {
            await page.evaluate(() => window.scrollBy(0, 400));
          }
          break;
      }
      return {
        status: 'passed',
        error: null,
        healed: true,
        healMethod: `Element appeared after modal animation wait`,
        resolvedSelector: selector
      };
    }
  } catch (waitErr) {
    console.warn(`[Self-Healing] Element did not appear during modal animation wait: ${waitErr.message}`);
  }

  // Now run overlay detection — but only dismiss overlays that do NOT contain the target
  // and use close-button clicks only (no Escape key) if there is a modal on the page
  // that could contain the target element.
  try {
    console.log(`[Self-Healing] Action obstructed on "${selector}". Running dynamic overlay detection...`);
    const overlayDiagnostics = await detectAndCloseOverlays(page, selector);
    if (overlayDiagnostics.dismissed) {
      console.log(`[Self-Healing] Active overlays/dismissal actions taken: ${overlayDiagnostics.actionsTaken.join(', ')}. Retrying standard action on "${selector}"...`);
      try {
        switch (action) {
          case 'click':
            await page.waitForSelector(selector, { state: 'visible', timeout: 5000 });
            await page.locator(selector).first().click({ timeout: 5000 });
            break;
          case 'fill':
            await page.waitForSelector(selector, { state: 'visible', timeout: 5000 });
            await page.locator(selector).first().clear({ timeout: 5000 });
            await page.locator(selector).first().fill(value, { timeout: 5000 });
            break;
          case 'scroll':
            if (selector) {
              await page.waitForSelector(selector, { state: 'visible', timeout: 5000 });
              await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 5000 });
            } else {
              await page.evaluate(() => window.scrollBy(0, 400));
            }
            break;
        }
        return {
          status: 'passed',
          error: null,
          healed: true,
          healMethod: `Overlay recovery: Dismissed overlays (${overlayDiagnostics.actionsTaken.join(', ')})`,
          resolvedSelector: selector
        };
      } catch (retryErr) {
        console.warn(`⚠️ Retry failed after overlay dismissal: ${retryErr.message}`);
        // Enrich the lastError object with full diagnostics for debugging output
        lastError = new Error(`${lastError?.message || ''} [Diagnostics -> Detected Overlays: ${overlayDiagnostics.detectedOverlays.join(', ') || 'none'}, Actions: ${overlayDiagnostics.actionsTaken.join(', ') || 'none'}, Retry error: ${retryErr.message}]`);
      }
    }
  } catch (err) {
    console.warn(`⚠️ Strategy 1.5 (Overlay Recovery) failed: ${err.message}`);
  }

  // ==========================================================================
  // STRATEGY 2: Force Interaction (Bypass Overlapping / Visually Obstructed Elements)
  // ==========================================================================
  // Try if selector is present in DOM but is overlapping, covered, or has pointer-events: none
  try {
    const isAttached = await page.locator(selector).first().count() > 0;
    if (isAttached) {
      console.log(`[Self-Healing] Element exists in DOM. Bypassing obstruction via Force Action...`);
      if (action === 'click') {
        await page.locator(selector).first().click({ force: true, timeout: 3000 });
        return {
          status: 'passed',
          error: null,
          healed: true,
          healMethod: 'Force click (bypassed overlay)',
          resolvedSelector: selector
        };
      } else if (action === 'fill') {
        await page.locator(selector).first().fill(value, { force: true, timeout: 3000 });
        return {
          status: 'passed',
          error: null,
          healed: true,
          healMethod: 'Force fill (bypassed overlay)',
          resolvedSelector: selector
        };
      }
    }
  } catch (err) {
    console.warn(`⚠️ Strategy 2 (Force Action) failed: ${err.message}`);
  }

  // ==========================================================================
  // STRATEGY 3: Dispatch DOM Events Directly (Last resort for existing elements)
  // ==========================================================================
  try {
    const isAttached = await page.locator(selector).first().count() > 0;
    if (isAttached) {
      console.log(`[Self-Healing] Attempting direct DOM event dispatch...`);
      if (action === 'click') {
        await page.locator(selector).first().dispatchEvent('click');
        return {
          status: 'passed',
          error: null,
          healed: true,
          healMethod: 'Direct DOM click event',
          resolvedSelector: selector
        };
      } else if (action === 'fill') {
        const isEditable = await page.locator(selector).first().evaluate(el => {
          const tag = el.tagName.toLowerCase();
          return tag === 'input' || tag === 'textarea' || tag === 'select' || el.hasAttribute('contenteditable');
        }).catch(() => false);
        if (!isEditable) throw new Error('Target element is not input-capable or editable');

        await page.locator(selector).first().focus();
        await page.locator(selector).first().evaluate((el, val) => {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
        return {
          status: 'passed',
          error: null,
          healed: true,
          healMethod: 'Direct DOM fill event',
          resolvedSelector: selector
        };
      }
    }
  } catch (err) {
    console.warn(`⚠️ Strategy 3 (DOM Dispatch) failed: ${err.message}`);
  }

  // ==========================================================================
  // STRATEGY 4: Text-based Alternative Locators
  // ==========================================================================
  const keywords = extractKeywords(selector);
  console.log(`[Self-Healing] Extracted selector keywords: ${JSON.stringify(keywords)}`);

  if (keywords.length > 0) {
    for (const kw of keywords) {
      try {
        console.log(`[Self-Healing] Retrying using Text strategy: "${kw}"`);
        let locator = null;

        if (action === 'click') {
          // Look for buttons, links, or inputs with text
          const options = [
            page.getByRole('button', { name: kw, exact: false }),
            page.getByRole('link', { name: kw, exact: false }),
            page.getByText(kw, { exact: false }),
            page.locator(`text="${kw}"`).first()
          ];

          for (const loc of options) {
            if (await loc.count() > 0 && await loc.first().isVisible()) {
              locator = loc.first();
              break;
            }
          }
          if (locator) {
            await locator.click({ timeout: 4000 });
            return {
              status: 'passed',
              error: null,
              healed: true,
              healMethod: `Text locator match ("${kw}")`,
              resolvedSelector: `text="${kw}"`
            };
          }
        } else if (action === 'fill') {
          // Look for inputs by placeholder, label, name, or text nearby
          const options = [
            page.getByPlaceholder(kw, { exact: false }),
            page.getByLabel(kw, { exact: false }),
            page.locator(`input[name*="${kw}" i]`).first(),
            page.locator(`input[placeholder*="${kw}" i]`).first()
          ];

          for (const loc of options) {
            if (await loc.count() > 0 && await loc.first().isVisible()) {
              locator = loc.first();
              break;
            }
          }

          if (locator) {
            await locator.clear({ timeout: 4000 });
            await locator.fill(value, { timeout: 4000 });
            return {
              status: 'passed',
              error: null,
              healed: true,
              healMethod: `Text input locator match ("${kw}")`,
              resolvedSelector: `input[placeholder/label*="${kw}"]`
            };
          }
        }
      } catch (err) {
        console.warn(`⚠️ Text fallback failed for keyword "${kw}": ${err.message}`);
      }
    }
  }

  // ==========================================================================
  // STRATEGY 5: XPath Alternative Locators
  // ==========================================================================
  if (keywords.length > 0) {
    for (const kw of keywords) {
      try {
        console.log(`[Self-Healing] Retrying using XPath strategy for: "${kw}"`);
        const xpaths = [
          `//*[contains(text(), '${kw}')]`,
          `//button[contains(., '${kw}')]`,
          `//input[contains(@placeholder, '${kw}')]`,
          `//input[contains(@name, '${kw}')]`,
          `//a[contains(text(), '${kw}')]`
        ];

        for (const xpath of xpaths) {
          const loc = page.locator(`xpath=${xpath}`).first();
          if (await loc.count() > 0 && await loc.isVisible()) {
            if (action === 'click') {
              await loc.click({ timeout: 4000 });
            } else if (action === 'fill') {
              await loc.clear({ timeout: 4000 });
              await loc.fill(value, { timeout: 4000 });
            }
            return {
              status: 'passed',
              error: null,
              healed: true,
              healMethod: `XPath matching "${kw}"`,
              resolvedSelector: xpath
            };
          }
        }
      } catch (err) {
        console.warn(`⚠️ XPath fallback failed for keyword "${kw}": ${err.message}`);
      }
    }
  }

  // ==========================================================================
  // STRATEGY 6: Fuzzy DOM Similarity Matcher (Scoring tags, classes, and text)
  // ==========================================================================
  let fuzzyMatch = null;
  try {
    console.log(`[Self-Healing] Scanning page DOM using Fuzzy Similarity Matcher...`);
    fuzzyMatch = await page.evaluate(({ originalSelector }) => {
      // Collect visible interactive elements
      const elements = Array.from(document.querySelectorAll('a, button, input, textarea, select, [role="button"], [onclick]'));
      
      const visibleElements = elements.filter(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && 
               rect.height > 0 && 
               style.visibility !== 'hidden' && 
               style.opacity !== '0' && 
               style.display !== 'none';
      });

      if (visibleElements.length === 0) return null;

      // Extract alphanumeric tokens from the original selector
      const cleanSelector = originalSelector.toLowerCase().replace(/[^a-z0-9]/g, ' ');
      const tokens = cleanSelector.split(/\s+/).filter(t => t.length > 1);

      let bestEl = null;
      let highestScore = -1;

      visibleElements.forEach(el => {
        let score = 0;
        const tag = el.tagName.toLowerCase();
        const id = (el.id || '').toLowerCase();
        const cls = (el.className || '').toLowerCase();
        const txt = (el.textContent || '').trim().toLowerCase();
        const ph = (el.placeholder || '').toLowerCase();
        const nm = (el.name || '').toLowerCase();
        const val = (el.value || '').toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();

        // 1. Tag match
        if (originalSelector.toLowerCase().includes(tag)) {
          score += 8;
        }

        // 2. Token match
        tokens.forEach(tok => {
          if (id.includes(tok)) score += 20;
          if (nm.includes(tok)) score += 15;
          if (ph.includes(tok)) score += 15;
          if (aria.includes(tok)) score += 15;
          if (txt.includes(tok)) score += 10;
          if (cls.includes(tok)) score += 6;
          if (val.includes(tok)) score += 6;
        });

        if (score > highestScore) {
          highestScore = score;
          bestEl = el;
        }
      });

      // Threshold check to avoid random matches
      if (highestScore > 8 && bestEl) {
        // Build a robust XPath for this element
        const getXPath = (element) => {
          if (element.id) return `//*[@id="${element.id}"]`;
          if (element === document.body) return 'body';

          let index = 0;
          const siblings = element.parentNode.childNodes;
          for (let i = 0; i < siblings.length; i++) {
            const sibling = siblings[i];
            if (sibling === element) {
              return getXPath(element.parentNode) + '/' + element.tagName.toLowerCase() + '[' + (index + 1) + ']';
            }
            if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
              index++;
            }
          }
        };

        const rect = bestEl.getBoundingClientRect();
        return {
          xpath: getXPath(bestEl),
          tagName: bestEl.tagName.toLowerCase(),
          id: bestEl.id || null,
          text: bestEl.textContent.trim().substring(0, 30),
          centerX: rect.left + rect.width / 2 + window.scrollX,
          centerY: rect.top + rect.height / 2 + window.scrollY,
          score: highestScore
        };
      }
      return null;
    }, { originalSelector: selector });

    if (fuzzyMatch) {
      console.log(`[Self-Healing] Fuzzy DOM Match found: ${fuzzyMatch.tagName}${fuzzyMatch.id ? `#${fuzzyMatch.id}` : ''} with score ${fuzzyMatch.score}`);
      const loc = page.locator(`xpath=${fuzzyMatch.xpath}`).first();

      if (await loc.count() > 0) {
        if (action === 'click') {
          await loc.click({ timeout: 4000 });
        } else if (action === 'fill') {
          await loc.clear({ timeout: 4000 });
          await loc.fill(value, { timeout: 4000 });
        }
        return {
          status: 'passed',
          error: null,
          healed: true,
          healMethod: `Fuzzy DOM match (XPath: ${fuzzyMatch.xpath}, Score: ${fuzzyMatch.score})`,
          resolvedSelector: fuzzyMatch.xpath
        };
      }
    }
  } catch (err) {
    console.warn(`⚠️ Fuzzy DOM strategy failed: ${err.message}`);
  }

  // ==========================================================================
  // STRATEGY 7: Relative Coordinate Click / Parent-Label Bounding Box Offsets
  // ==========================================================================
  try {
    // A0. Label element target click/fill (If target selector is a label, click relative to it)
    const originalIsLabel = await page.locator(selector).first().evaluate(el => el.tagName.toLowerCase() === 'label').catch(() => false);
    if (originalIsLabel) {
      console.log(`[Self-Healing] Target is a Label element. Clicking relative to its bounding box...`);
      const box = await page.locator(selector).first().boundingBox();
      if (box) {
        const targetX = box.x + box.width / 2;
        const targetY = box.y + box.height + 20;
        console.log(`[Self-Healing] Label element found. Clicking relative coordinates: (${targetX}, ${targetY})`);
        await page.mouse.click(targetX, targetY);
        if (action === 'fill') {
          await page.keyboard.press('Control+A');
          await page.keyboard.press('Backspace');
          await page.keyboard.insertText(value);
        }
        return {
          status: 'passed',
          error: null,
          healed: true,
          healMethod: `Coordinate offset relative to targeted Label element`,
          resolvedSelector: `Coordinates(${targetX.toFixed(0)}, ${targetY.toFixed(0)})`
        };
      }
    }

    // A. Label Offset Click (E.g. find label for keywords, click next/below it)
    if (keywords.length > 0 && (action === 'click' || action === 'fill')) {
      for (const kw of keywords) {
        console.log(`[Self-Healing] Trying label-relative coordinate search for: "${kw}"`);
        const labelLocator = page.locator(`label:has-text("${kw}")`).first();
        if (await labelLocator.count() > 0 && await labelLocator.isVisible()) {
          const box = await labelLocator.boundingBox();
          if (box) {
            // Usually form inputs are 100px to the right of the label center, or 35px below it
            const targetX = box.x + box.width + 80;
            const targetY = box.y + box.height / 2;
            console.log(`[Self-Healing] Label found. Clicking relative coordinates: (${targetX}, ${targetY})`);

            await page.mouse.click(targetX, targetY);
            if (action === 'fill') {
              await page.keyboard.press('Control+A');
              await page.keyboard.press('Backspace');
              await page.keyboard.insertText(value);
            }
            return {
              status: 'passed',
              error: null,
              healed: true,
              healMethod: `Coordinate offset relative to Label "${kw}"`,
              resolvedSelector: `Coordinates(${targetX.toFixed(0)}, ${targetY.toFixed(0)})`
            };
          }
        }
      }
    }

    // B. Parent Center click (Trim selector to find parent container center)
    const parentSelector = getParentSelector(selector);
    if (parentSelector && parentSelector !== selector) {
      console.log(`[Self-Healing] Original selector failed. Attempting click at parent center: "${parentSelector}"`);
      const parentLoc = page.locator(parentSelector).first();
      if (await parentLoc.count() > 0 && await parentLoc.isVisible()) {
        const box = await parentLoc.boundingBox();
        if (box) {
          const targetX = box.x + box.width / 2;
          const targetY = box.y + box.height / 2;
          await page.mouse.click(targetX, targetY);
          if (action === 'fill') {
            await page.keyboard.press('Control+A');
            await page.keyboard.press('Backspace');
            await page.keyboard.insertText(value);
          }
          return {
            status: 'passed',
            error: null,
            healed: true,
            healMethod: `Coordinate center of parent element "${parentSelector}"`,
            resolvedSelector: `Coordinates(${targetX.toFixed(0)}, ${targetY.toFixed(0)})`
          };
        }
      }
    }

    // C. Fuzzy coordinates click (If fuzzy matching returned coords but selector failed to interact)
    if (fuzzyMatch && fuzzyMatch.centerX && fuzzyMatch.centerY) {
      console.log(`[Self-Healing] Clicking fuzzy coordinates direct: (${fuzzyMatch.centerX}, ${fuzzyMatch.centerY})`);
      await page.mouse.click(fuzzyMatch.centerX, fuzzyMatch.centerY);
      if (action === 'fill') {
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await page.keyboard.insertText(value);
      }
      return {
        status: 'passed',
        error: null,
        healed: true,
        healMethod: `Direct coordinates of fuzzy element match`,
        resolvedSelector: `Coordinates(${fuzzyMatch.centerX.toFixed(0)}, ${fuzzyMatch.centerY.toFixed(0)})`
      };
    }
  } catch (err) {
    console.warn(`⚠️ Relative coordinate strategy failed: ${err.message}`);
  }

  // If we made it here, all attempts failed
  console.error(`❌ Self-healing exhausted for selector "${selector}". All strategies failed.`);
  return {
    status: 'failed',
    error: lastError?.message || `Failed to perform ${action} on "${selector}"`,
    healed: false,
    healMethod: null,
    resolvedSelector: null
  };
}

/**
 * Extract semantic keywords from selector to try text matches
 */
function extractKeywords(selector) {
  if (!selector) return [];

  // Match text in quotes first: e.g. input[placeholder="User Name"] -> ["User Name"]
  const quoteMatches = [...selector.matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
  if (quoteMatches.length > 0) {
    return quoteMatches.map(q => q.trim()).filter(q => q.length > 2);
  }

  // Strip non-alphanumeric, split by spaces, hyphens, underscores
  const clean = selector.replace(/[^a-zA-Z0-9-_]/g, ' ');
  return clean
    .split(/[\s-_]+/)
    .map(w => w.trim())
    // Filter out common short words and tag names to get unique tokens
    .filter(w => w.length > 2 && isNaN(w) && !['input', 'button', 'form', 'class', 'type', 'text', 'first', 'child', 'role', 'name', 'span', 'div', 'select'].includes(w.toLowerCase()));
}

/**
 * Safely parse a parent selector by stripping the last descendant selector
 */
function getParentSelector(selector) {
  if (!selector) return null;
  const parts = selector.trim().split(/\s*>\s*|\s+/);
  if (parts.length > 1) {
    // Remove the last token (the target element) to get the parent path
    parts.pop();
    return parts.join(' ');
  }
  return null;
}

/**
 * Detects and dismisses common popups (cookie banners, newsletters, modals)
 * @param {import('playwright').Page} page - Playwright page
 * @returns {Promise<boolean>} true if any popup was dismissed
 */
export async function dismissCommonPopups(page) {
  const popups = [
    // Cookie banners (accept buttons) — CookieYes variants
    { selector: '.cky-btn-accept', action: 'click', name: 'CookieYes Accept All' },
    { selector: '.cky-btn-reject', action: 'click', name: 'CookieYes Reject All' },
    { selector: '[aria-label="Accept All"]', action: 'click', name: 'CookieYes Accept All (aria)' },
    { selector: 'button[data-cky-tag="accept-button"]', action: 'click', name: 'CookieYes Data Tag Accept' },
    { selector: 'button[data-cky-tag="reject-button"]', action: 'click', name: 'CookieYes Data Tag Reject' },
    { selector: 'div.cky-consent-container button', action: 'click', name: 'CookieYes Container Button' },
    // Generic cookie/consent banners
    { selector: 'button:has-text("Accept All")', action: 'click', name: 'Accept All button' },
    { selector: 'button:has-text("Accept Cookies")', action: 'click', name: 'Accept Cookies button' },
    { selector: 'button:has-text("Accept")', action: 'click', name: 'Accept button' },
    { selector: 'button:has-text("Reject All")', action: 'click', name: 'Reject All button' },
    { selector: 'button:has-text("Got it")', action: 'click', name: 'Got it button' },
    { selector: 'button:has-text("Agree")', action: 'click', name: 'Agree button' },
    { selector: 'button:has-text("OK")', action: 'click', name: 'OK button' },
    { selector: '#onetrust-accept-btn-handler', action: 'click', name: 'OneTrust Accept' },
    { selector: '[data-testid="cookie-accept"]', action: 'click', name: 'Test ID Cookie Accept' },
    
    // Newsletter popups & marketing close buttons
    { selector: '.mailpoet_form_close_icon', action: 'click', name: 'MailPoet Form Close Icon' },
    { selector: '.cky-btn-close', action: 'click', name: 'CookieYes Close' },
    // NOTE: Do NOT close login/register modals here — those are required for tests, not popups
  ];

  let dismissedAny = false;

  for (const popup of popups) {
    try {
      const locator = page.locator(popup.selector).first();
      if (await locator.count() > 0) {
        const isVisible = await locator.isVisible();
        if (isVisible) {
          console.log(`[Popup-Dismissal] Detected popup: ${popup.name}. Attempting to dismiss...`);
          if (popup.action === 'click') {
            await locator.click({ timeout: 2000 });
          }
          console.log(`[Popup-Dismissal] Successfully dismissed: ${popup.name}`);
          dismissedAny = true;
          // Short pause after dismissal
          await page.waitForTimeout(500);
        }
      }
    } catch (err) {
      // Ignore errors trying to check/click individual popups
    }
  }

  if (dismissedAny) {
    // Wait for animations/transitions
    await page.waitForTimeout(500);
  }

  return dismissedAny;
}

/**
 * Automatically detects and closes visible modals, dialogs, and overlays
 * using selector patterns like [role="dialog"], .modal, close buttons, or the Escape key.
 * Returns diagnostic logs of what was detected and performed.
 * Prevents closing an overlay if it contains the target element.
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @returns {Promise<{ dismissed: boolean, actionsTaken: string[], detectedOverlays: string[] }>}
 */
export async function detectAndCloseOverlays(page, selector = '') {
  const diagnostics = {
    dismissed: false,
    actionsTaken: [],
    detectedOverlays: []
  };

  try {
    // 1. Tag the target element if it exists in the DOM to check containment
    let targetTagged = false;
    if (selector) {
      try {
        const targetLoc = page.locator(selector).first();
        if (await targetLoc.count() > 0) {
          await targetLoc.evaluate(el => el.setAttribute('data-sh-target', 'true'));
          targetTagged = true;
        }
      } catch (err) {
        console.warn(`[Overlay-Dismissal] Failed to tag target element: ${err.message}`);
      }
    }

    // 2. Identify visible overlay elements
    const overlaySelectors = [
      '[role="dialog"]',
      '.modal',
      '.overlay',
      '.popup',
      '[class*="modal" i]',
      '[class*="popup" i]',
      '[class*="overlay" i]',
      '[class*="consent" i]',
      '[class*="dialog" i]',
      '[class*="mailpoet" i]',
      '[class*="cookie" i]',
      '[class*="banner" i]',
      '[class*="newsletter" i]'
    ];

    let skippedAnyOverlayContainingTarget = false;
    const visibleOverlays = [];

    for (const overlaySel of overlaySelectors) {
      try {
        const locators = page.locator(overlaySel);
        const count = await locators.count();
        for (let i = 0; i < count; i++) {
          const loc = locators.nth(i);
          if (await loc.isVisible()) {
            // Verify position styling to ensure it is a floating overlay/modal/banner
            const position = await loc.evaluate(el => window.getComputedStyle(el).position).catch(() => 'static');
            if (position !== 'fixed' && position !== 'absolute' && position !== 'sticky') {
              continue;
            }

            const tagName = await loc.evaluate(el => el.tagName.toLowerCase()).catch(() => overlaySel);
            const id = await loc.getAttribute('id').catch(() => '') || '';
            const cls = await loc.getAttribute('class').catch(() => '') || '';
            const overlayInfo = `${tagName}${id ? '#' + id : ''}${cls ? '.' + cls.split(/\s+/).join('.') : ''}`;

            // Check if this specific overlay contains the target element
            let containsTarget = false;
            if (targetTagged) {
              containsTarget = await loc.evaluate(overlayEl => {
                const target = document.querySelector('[data-sh-target="true"]');
                return target ? overlayEl.contains(target) : false;
              }).catch(() => false);
            }

            // Also check keyword containment if target was not tagged (e.g. invalid CSS selector like 'username')
            if (!containsTarget && selector) {
              const keywords = extractKeywords(selector);
              if (keywords.length > 0) {
                containsTarget = await loc.evaluate((overlayEl, kws) => {
                  const txt = (overlayEl.textContent || '').toLowerCase();
                  return kws.some(kw => {
                    const cleanKw = kw.toLowerCase();
                    if (txt.includes(cleanKw)) return true;
                    const inputs = Array.from(overlayEl.querySelectorAll('input, textarea, select'));
                    return inputs.some(input => {
                      const name = (input.name || '').toLowerCase();
                      const ph = (input.placeholder || '').toLowerCase();
                      const id = (input.id || '').toLowerCase();
                      return name.includes(cleanKw) || ph.includes(cleanKw) || id.includes(cleanKw);
                    });
                  });
                }, keywords).catch(() => false);
              }
            }

            if (containsTarget) {
              console.log(`[Overlay-Dismissal] Pre-pass: Overlay "${overlayInfo}" contains target. Skipping it, and Escape key will be disabled.`);
              skippedAnyOverlayContainingTarget = true;
            } else {
              // Avoid duplicates if multiple selectors match the same overlay element
              const isDuplicate = visibleOverlays.some(async item => await item.loc.elementHandle() === await loc.elementHandle());
              if (!isDuplicate) {
                visibleOverlays.push({ loc, info: overlayInfo });
              }
            }
          }
        }
      } catch (_) {}
    }

    // 3. Process overlays that do NOT contain the target element
    for (const { loc, info: overlayInfo } of visibleOverlays) {
      diagnostics.detectedOverlays.push(overlayInfo);

      // Try closing via close buttons inside this overlay
      const closeSelectors = [
        // CKY (CookieYes) consent banner buttons — must come first as Escape does not dismiss CKY
        'button[data-cky-tag="accept-button"]',
        'button[data-cky-tag="reject-button"]',
        'button[data-cky-tag="close-button"]',
        '.cky-btn-accept',
        '.cky-btn-reject',
        '.cky-btn-close',
        '[aria-label="Accept All"]',
        '[aria-label="Reject All"]',
        // Generic close/accept buttons
        'button[class*="close" i]',
        'span[class*="close" i]',
        'a[class*="close" i]',
        'div[class*="close" i]',
        'input[class*="close" i]',
        '[aria-label*="close" i]',
        '[class*="close-button" i]',
        '[class*="close-icon" i]',
        'button:has-text("Accept All")',
        'button:has-text("Accept Cookies")',
        'button:has-text("Accept")',
        'button:has-text("Reject All")',
        'button:has-text("Close")',
        'button:has-text("×")',
        'span:has-text("×")'
      ];

      let closedThisOverlay = false;
      for (const closeSel of closeSelectors) {
        try {
          const closeLoc = loc.locator(closeSel).first();
          if (await closeLoc.count() > 0 && await closeLoc.isVisible()) {
            console.log(`[Overlay-Dismissal] Found close button inside overlay "${overlayInfo}": "${closeSel}". Clicking...`);
            await closeLoc.click({ timeout: 2000 });
            diagnostics.actionsTaken.push(`Clicked close button inside overlay "${overlayInfo}": "${closeSel}"`);
            closedThisOverlay = true;
            diagnostics.dismissed = true;
            await page.waitForTimeout(500); // Wait for transition
            break; // Move to next overlay
          }
        } catch (_) {}
      }

      // If we couldn't close it via close button, try pressing Escape key
      // ONLY if there is no active overlay containing the target element AND
      // there is no visible login/dialog modal on the page (to avoid closing legitimate modals).
      if (!closedThisOverlay) {
        if (skippedAnyOverlayContainingTarget) {
          console.log(`[Overlay-Dismissal] Skipping Escape keypress for "${overlayInfo}" because another overlay contains the target element.`);
        } else {
          // Check if pressing Escape could close a legitimate login/form modal
          const hasLoginModal = await page.evaluate(() => {
            const modalSelectors = [
              '.xoo-el-modal',
              '[class*="login"][class*="modal"]',
              '[class*="modal"][class*="login"]',
              '.woocommerce-form-login',
              '[role="dialog"] form',
              '[class*="popup"] form input[type="password"]'
            ];
            for (const sel of modalSelectors) {
              try {
                const el = document.querySelector(sel);
                if (el) {
                  const style = window.getComputedStyle(el);
                  if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    return true;
                  }
                }
              } catch (_) {}
            }
            return false;
          }).catch(() => false);

          if (hasLoginModal) {
            console.log(`[Overlay-Dismissal] Skipping Escape keypress for "${overlayInfo}" because a login/form modal is visible — Escape would close it.`);
          } else {
            console.log(`[Overlay-Dismissal] Pressing Escape key to close overlay: "${overlayInfo}"`);
            await page.keyboard.press('Escape');
            diagnostics.actionsTaken.push(`Pressed Escape key for overlay: "${overlayInfo}"`);
            diagnostics.dismissed = true;
            await page.waitForTimeout(500); // Wait for transition
          }
        }
      }
    }

    // 4. Clean up tag from target element
    if (targetTagged && selector) {
      try {
        const targetLoc = page.locator(selector).first();
        if (await targetLoc.count() > 0) {
          await targetLoc.evaluate(el => el.removeAttribute('data-sh-target'));
        }
      } catch (_) {}
    }

  } catch (err) {
    console.error(`[Overlay-Dismissal] Error during overlay detection/dismissal: ${err.message}`);
    diagnostics.actionsTaken.push(`Error: ${err.message}`);
  }

  return diagnostics;
}


