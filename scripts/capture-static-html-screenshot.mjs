#!/usr/bin/env node

const ERROR_PREFIX = "browser-backed QA requires Playwright/Chromium or a configured browser capture helper";

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !key.startsWith("--") || value === undefined) {
      throw new Error("Usage: capture-static-html-screenshot.mjs --html HTML --output PNG --width WIDTH --height HEIGHT");
    }
    args[key.slice(2)] = value;
  }
  return args;
}

function parsePositiveInteger(value) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) {
    throw new Error("Usage: capture-static-html-screenshot.mjs --html HTML --output PNG --width WIDTH --height HEIGHT");
  }
  return Number(value);
}

async function main() {
  const args = parseArgs(process.argv);
  const htmlPath = args.html;
  const outputPath = args.output;
  const width = parsePositiveInteger(args.width);
  const height = parsePositiveInteger(args.height);

  if (!htmlPath || !outputPath) {
    throw new Error("Usage: capture-static-html-screenshot.mjs --html HTML --output PNG --width WIDTH --height HEIGHT");
  }

  const { pathToFileURL } = await import("node:url");
  const { chromium } = await import("@playwright/test");
  const launchAttempts = [
    { backend: "playwright-chromium", options: { headless: true } },
    { backend: "playwright-chrome-channel", options: { channel: "chrome", headless: true } },
    {
      backend: "playwright-chrome-app",
      options: {
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless: true,
      },
    },
  ];
  let browser;
  let backend;
  let lastError;
  for (const attempt of launchAttempts) {
    try {
      browser = await chromium.launch(attempt.options);
      backend = attempt.backend;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!browser || !backend) {
    throw lastError ?? new Error("No browser launch attempt was made.");
  }
  try {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { width, height },
    });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.screenshot({ path: outputPath, fullPage: false });
    console.log(JSON.stringify({
      backend,
      html_path: htmlPath,
      screenshot_path: outputPath,
      viewport: `${width}x${height}`,
    }));
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${ERROR_PREFIX}: ${message}`);
  process.exitCode = 2;
}
