#!/usr/bin/env bun
import { mkdir, access } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { detectInput } from './pipeline/detect';
import { renderPdf } from './pipeline/render-pdf';
import { renderImages } from './pipeline/render-image';
import { createManifest, writeManifest } from './pipeline/manifest';
import { processPages } from './pipeline/process';
import { extractPages } from './pipeline/extract';
import type { RenderOptions } from './types';

function printUsage(): void {
  console.log(`
doc2pages - Document to scanned pages converter

Usage:
  doc2pages <input> <output> [options]

Arguments:
  input   Path to PDF file, image file, or folder of images
  output  Output directory for pages and manifest

Options:
  --dpi <number>       Resolution for PDF rendering (default: 200)
  --concurrency <n>    Number of parallel processes (default: 20)
  --help               Show this help message

Examples:
  doc2pages book.pdf ./output --dpi 200
  doc2pages ./scans ./output
`);
}

function parseArgs(args: string[]): {
  input: string;
  output: string;
  options: RenderOptions;
} | null {
  const positional: string[] = [];
  let dpi = 200;
  let concurrency = 20;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--dpi' && args[i + 1]) {
      dpi = parseInt(args[++i], 10);
      if (isNaN(dpi) || dpi < 72 || dpi > 1200) {
        console.error('Error: DPI must be between 72 and 1200');
        return null;
      }
    } else if (arg === '--concurrency' && args[i + 1]) {
      concurrency = parseInt(args[++i], 10);
      if (isNaN(concurrency) || concurrency < 1) {
        console.error('Error: Concurrency must be at least 1');
        return null;
      }
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    } else {
      console.error(`Error: Unknown option ${arg}`);
      return null;
    }
  }

  if (positional.length < 2) {
    console.error('Error: Missing required arguments');
    printUsage();
    return null;
  }

  return {
    input: resolve(positional[0]),
    output: resolve(positional[1]),
    options: { dpi, concurrency },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const parsed = parseArgs(args);
  if (!parsed) {
    process.exit(1);
  }

  const { input, output, options } = parsed;

  // Validate input exists
  try {
    await access(input);
  } catch {
    console.error(`Error: Input path does not exist: ${input}`);
    process.exit(1);
  }

  // Create output directory
  await mkdir(output, { recursive: true });

  // Detect input type
  console.log(`Detecting input type for: ${input}`);
  const detection = await detectInput(input);

  if (detection.type === 'unsupported') {
    console.error('Error: Unsupported input type');
    process.exit(1);
  }

  console.log(`Detected: ${detection.type}`);
  console.log(`Processing with DPI=${options.dpi}`);

  let result;
  let sourceName: string;

  if (detection.type === 'pdf') {
    sourceName = basename(detection.files[0]);
    console.log(`Rendering PDF: ${sourceName}`);
    result = await renderPdf(detection.files[0], output, options);
  } else {
    sourceName = detection.type === 'image' ? basename(detection.files[0]) : basename(input);
    console.log(`Processing ${detection.files.length} image(s)`);
    result = await renderImages(detection.files, output, options);
  }

  // Process pages (grayscale, contrast, deskew, trim, sharpen, WebP)
  const pagesDir = join(output, 'pages');
  console.log(`Processing ${result.pages.length} page(s) through image pipeline...`);
  const processed = await processPages(pagesDir, result.pages, options.concurrency);

  // Extract text from pages (if API key is available)
  let finalPages = processed.pages;
  let extractionErrors: typeof processed.errors = [];

  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    console.log(`Extracting text from ${processed.pages.length} page(s) via Gemini...`);
    const extracted = await extractPages(pagesDir, processed.pages, options.concurrency);
    finalPages = extracted.pages;
    extractionErrors = extracted.errors;
  } else {
    console.log('Skipping text extraction (GOOGLE_GENERATIVE_AI_API_KEY not set)');
  }

  const allErrors = [...result.errors, ...processed.errors, ...extractionErrors];

  // Generate manifest
  const manifest = createManifest({
    source: sourceName,
    dpi: options.dpi,
    format: 'webp',
    pages: finalPages,
    errors: allErrors,
    toolchain: result.toolchain,
  });

  await writeManifest(output, manifest);

  console.log(`\nDone!`);
  console.log(`  Pages: ${manifest.pageCount}`);
  console.log(`  Errors: ${manifest.errors.length}`);
  console.log(`  Output: ${output}`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
