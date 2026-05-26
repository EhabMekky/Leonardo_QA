import { chromium } from 'playwright';

async function test() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  console.log('Navigating to https://bitheap.tech/...');
  await page.goto('https://bitheap.tech/', { waitUntil: 'domcontentloaded' });
  
  const elements = await page.evaluate(() => {
    const list = [];
    // Find all links and buttons
    const nodes = document.querySelectorAll('a, button, [role="button"]');
    for (const node of nodes) {
      const text = node.textContent.trim();
      if (text.toLowerCase().includes('login') || text.toLowerCase().includes('log in') || (node.id && node.id.toLowerCase().includes('login'))) {
        list.push({
          tagName: node.tagName.toLowerCase(),
          text: text,
          id: node.id || null,
          className: node.className || null,
          href: node.getAttribute('href') || null,
          outerHTML: node.outerHTML.substring(0, 200)
        });
      }
    }
    return list;
  });

  console.log('Detected login elements:');
  console.log(JSON.stringify(elements, null, 2));

  await browser.close();
}

test().catch(console.error);
