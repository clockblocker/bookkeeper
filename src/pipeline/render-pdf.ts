import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { exec, getCommandVersion } from './exec';
import type { RenderOptions, PageInfo, PageError, Toolchain } from '../types';

interface PdfRenderResult {
  pages: PageInfo[];
  errors: PageError[];
  toolchain: Toolchain;
}

async function getPdfPageCount(pdfPath: string): Promise<number> {
  const result = await exec(['pdfinfo', pdfPath]);
  const match = result.stdout.match(/Pages:\s*(\d+)/);
  if (!match) {
    throw new Error('Could not determine PDF page count');
  }
  return parseInt(match[1], 10);
}

async function getImageDimensions(imagePath: string): Promise<{ width: number; height: number }> {
  const result = await exec(['identify', '-format', '%w %h', imagePath]);
  if (result.exitCode !== 0) {
    // Fallback: try to read with Bun
    return { width: 0, height: 0 };
  }
  const [width, height] = result.stdout.trim().split(' ').map(Number);
  return { width: width || 0, height: height || 0 };
}

async function renderPageRange(
  pdfPath: string,
  outputDir: string,
  firstPage: number,
  lastPage: number,
  options: RenderOptions,
  retryCount = 0
): Promise<{ success: number[]; failed: number[] }> {
  const formatFlag = options.format === 'png' ? '-png' : '-jpeg';
  const prefix = join(outputDir, 'page');

  const cmd = [
    'pdftoppm',
    formatFlag,
    '-r', String(options.dpi),
    '-f', String(firstPage),
    '-l', String(lastPage),
    pdfPath,
    prefix,
  ];

  const result = await exec(cmd, { timeout: 600000 });

  if (result.exitCode !== 0) {
    if (retryCount < 1) {
      return renderPageRange(pdfPath, outputDir, firstPage, lastPage, options, retryCount + 1);
    }
    const failed = Array.from({ length: lastPage - firstPage + 1 }, (_, i) => firstPage + i);
    return { success: [], failed };
  }

  const success = Array.from({ length: lastPage - firstPage + 1 }, (_, i) => firstPage + i);
  return { success, failed: [] };
}

export async function renderPdf(
  pdfPath: string,
  outputDir: string,
  options: RenderOptions
): Promise<PdfRenderResult> {
  const pagesDir = join(outputDir, 'pages');
  await mkdir(pagesDir, { recursive: true });

  const pageCount = await getPdfPageCount(pdfPath);
  const version = await getCommandVersion('pdftoppm');
  const toolchain: Toolchain = { renderer: 'pdftoppm', version };

  // For simplicity, render all pages in one go (pdftoppm handles it efficiently)
  // Could split into batches for very large PDFs
  const { success, failed } = await renderPageRange(
    pdfPath,
    pagesDir,
    1,
    pageCount,
    options
  );

  const pages: PageInfo[] = [];
  const errors: PageError[] = [];

  for (let i = 1; i <= pageCount; i++) {
    if (failed.includes(i)) {
      errors.push({ index: i, error: 'render failed' });
      continue;
    }

    // pdftoppm outputs page-01.png, page-02.png, etc.
    const paddedNum = String(i).padStart(String(pageCount).length, '0');
    const outputFile = `page-${paddedNum}.${options.format}`;
    const fullPath = join(pagesDir, outputFile);

    try {
      const dims = await getImageDimensions(fullPath);
      pages.push({
        index: i,
        file: outputFile,
        width: dims.width,
        height: dims.height,
      });
    } catch {
      errors.push({ index: i, error: 'failed to read output' });
    }
  }

  return { pages, errors, toolchain };
}
