// Renders each .slide in graphics.html to a 2000×2000 PNG in ./output.
// Usage: node render.mjs   (needs the `playwright` package and a Chromium build)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const names = ['01-hero', '02-whats-inside', '03-sample-questions', '04-two-booklets', '05-answer-sheet', '06-why-parents'];

mkdirSync(path.join(dir, 'output'), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1100 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(path.join(dir, 'graphics.html')).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
const slides = await page.$$('.slide');
for (const [i, slide] of slides.entries()) {
  await slide.screenshot({ path: path.join(dir, 'output', `${names[i] ?? `slide-${i + 1}`}.png`) });
}
await browser.close();
