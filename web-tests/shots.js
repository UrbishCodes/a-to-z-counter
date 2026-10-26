// Screenshots of the live page at phone and laptop widths, plus horizontal overflow check.
const { chromium } = require('playwright');
const out = '/tmp/claude-0/-home-claude/725d3a8e-b15c-542a-ae1c-a4dba8429538/scratchpad';

(async () => {
  const browser = await chromium.launch();
  const sizes = [
    ['phone', { width: 390, height: 844 }, true],
    ['laptop', { width: 1366, height: 820 }, false],
  ];
  for (const [name, viewport, mobile] of sizes) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto('http://localhost:8000/', { waitUntil: 'networkidle' });
    await page.fill('#gross', '7500');
    await page.fill('#stdRate', '39.59');
    await page.fill('#qty', '168');
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const inputSize = await page.evaluate(() => getComputedStyle(document.getElementById('gross')).fontSize);
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    console.log(`${name}: horizontal overflow ${overflow}px, input font ${inputSize}, page errors ${JSON.stringify(errs)}`);
    await ctx.close();
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
