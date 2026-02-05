import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { exec, getCommandVersion, batchExec } from './exec';
import { getImageDimensions } from './image-dimensions';
import type { RenderOptions, PageInfo, PageError, Toolchain } from '../types';

interface PdfRenderResult {
  pages: PageInfo[];
  errors: PageError[];
  toolchain: Toolchain;
}

interface PdfInfo {
  pageCount: number;
  /** Page dimensions in points (from pdfinfo "Page size" line), or null if not available */
  pageSizePts: { width: number; height: number } | null;
}

async function getPdfInfo(pdfPath: string): Promise<PdfInfo> {
  const result = await exec(['pdfinfo', pdfPath]);
  const pagesMatch = result.stdout.match(/Pages:\s*(\d+)/);
  if (!pagesMatch) {
    throw new Error('Could not determine PDF page count');
  }
  const pageCount = parseInt(pagesMatch[1], 10);

  // Try to parse "Page size: W x H pts"
  let pageSizePts: PdfInfo['pageSizePts'] = null;
  const sizeMatch = result.stdout.match(/Page size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/);
  if (sizeMatch) {
    pageSizePts = {
      width: parseFloat(sizeMatch[1]),
      height: parseFloat(sizeMatch[2]),
    };
  }

  return { pageCount, pageSizePts };
}

/** Convert PDF points to pixels at given DPI (matches pdftoppm rounding). */
function ptsToPixels(pts: number, dpi: number): number {
  return Math.ceil(pts * dpi / 72);
}

interface PageChunk {
  first: number;
  last: number;
}

function chunkPages(pageCount: number, concurrency: number): PageChunk[] {
  const numChunks = Math.min(concurrency, pageCount);
  const baseSize = Math.floor(pageCount / numChunks);
  const remainder = pageCount % numChunks;
  const chunks: PageChunk[] = [];
  let start = 1;
  for (let i = 0; i < numChunks; i++) {
    const size = baseSize + (i < remainder ? 1 : 0);
    chunks.push({ first: start, last: start + size - 1 });
    start += size;
  }
  return chunks;
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

  const [pdfInfo, version] = await Promise.all([
    getPdfInfo(pdfPath),
    getCommandVersion('pdftoppm'),
  ]);
  const { pageCount, pageSizePts } = pdfInfo;
  const toolchain: Toolchain = { renderer: 'pdftoppm', version };

  // Split rendering into parallel page-range chunks
  const chunks = chunkPages(pageCount, options.concurrency);
  const chunkResults = await batchExec(
    chunks,
    (chunk) => renderPageRange(pdfPath, pagesDir, chunk.first, chunk.last, options),
    chunks.length
  );

  // Merge results from all chunks
  const allSuccess: number[] = [];
  const allFailed: number[] = [];
  for (const { success, failed } of chunkResults) {
    allSuccess.push(...success);
    allFailed.push(...failed);
  }

  const errors: PageError[] = [];

  // Build list of page info for successful pages
  const pageFiles: { index: number; file: string; path: string }[] = [];

  for (let i = 1; i <= pageCount; i++) {
    if (allFailed.includes(i)) {
      errors.push({ index: i, error: 'render failed' });
      continue;
    }
    const paddedNum = String(i).padStart(String(pageCount).length, '0');
    const outputFile = `page-${paddedNum}.${options.format}`;
    const fullPath = join(pagesDir, outputFile);
    pageFiles.push({ index: i, file: outputFile, path: fullPath });
  }

  // Determine dimensions — try pdfinfo prediction first, then fall back to file reads
  let predictedDims: { width: number; height: number } | null = null;
  if (pageSizePts && pageFiles.length >= 2) {
    const predicted = {
      width: ptsToPixels(pageSizePts.width, options.dpi),
      height: ptsToPixels(pageSizePts.height, options.dpi),
    };

    // Spot-check first and last rendered pages against prediction
    const firstFile = pageFiles[0];
    const lastFile = pageFiles[pageFiles.length - 1];
    const [firstDims, lastDims] = await Promise.all([
      getImageDimensions(firstFile.path),
      getImageDimensions(lastFile.path),
    ]);

    if (
      firstDims.width === predicted.width &&
      firstDims.height === predicted.height &&
      lastDims.width === predicted.width &&
      lastDims.height === predicted.height
    ) {
      predictedDims = predicted;
    }
  }

  const pages: PageInfo[] = [];

  if (predictedDims) {
    // Uniform-size PDF: use predicted dimensions for all pages (skip per-file reads)
    for (const pf of pageFiles) {
      pages.push({
        index: pf.index,
        file: pf.file,
        width: predictedDims.width,
        height: predictedDims.height,
      });
    }
  } else {
    // Mixed-size or single-page PDF: read dimensions from each file
    const dimensionResults = await batchExec(
      pageFiles,
      async (pageFile) => {
        try {
          const dims = await getImageDimensions(pageFile.path);
          return { success: true as const, pageFile, dims };
        } catch {
          return { success: false as const, pageFile };
        }
      },
      options.concurrency
    );

    for (const result of dimensionResults) {
      if (result.success) {
        pages.push({
          index: result.pageFile.index,
          file: result.pageFile.file,
          width: result.dims.width,
          height: result.dims.height,
        });
      } else {
        errors.push({ index: result.pageFile.index, error: 'failed to read output' });
      }
    }
  }

  return { pages, errors, toolchain };
}
