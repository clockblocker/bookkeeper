import { join, basename, dirname } from 'node:path';
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { batchExec, execOrThrow } from './exec';
import type { PageInfo, PageError } from '../types';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: 'text' | 'image';
}

// ─── Prompts ────────────────────────────────────────────────────────────────

const TEXT_EXTRACTOR_SYSTEM_PROMPT = `You are a strict OCR engine. Extract all text from the provided page image and output it as clean Markdown.

Rules:
- Output ONLY the extracted text as Markdown. No preamble, no explanations.
- Preserve the original language of the text exactly as it appears.
- Use appropriate Markdown formatting (headings, lists, tables) to reflect the document structure.
- Do not describe images, diagrams, or decorative elements.
- If the page is blank or contains no readable text, output exactly: <!-- blank page -->`;

// ─── Tier 1: Chopper (Tesseract layout analysis) ────────────────────────────

async function chopPage(imagePath: string): Promise<Region[]> {
  const result = await execOrThrow([
    'tesseract', imagePath, 'stdout', '--psm', '1', 'tsv',
  ]);

  const lines = result.stdout.split('\n');
  if (lines.length < 2) return [];

  const header = lines[0].split('\t');
  const colIndex = (name: string) => header.indexOf(name);
  const iLevel = colIndex('level');
  const iBlockNum = colIndex('block_num');
  const iLeft = colIndex('left');
  const iTop = colIndex('top');
  const iWidth = colIndex('width');
  const iHeight = colIndex('height');
  const iText = colIndex('text');

  // Parse all data rows
  const rows = lines.slice(1)
    .map(line => line.split('\t'))
    .filter(cols => cols.length >= header.length);

  // Collect word-level text per block
  const blockWords = new Map<number, string[]>();
  for (const cols of rows) {
    const level = Number(cols[iLevel]);
    if (level !== 5) continue;
    const blockNum = Number(cols[iBlockNum]);
    const text = (cols[iText] ?? '').trim();
    if (!blockWords.has(blockNum)) blockWords.set(blockNum, []);
    blockWords.get(blockNum)!.push(text);
  }

  // Build regions from block-level (level 2) rows
  const regions: Region[] = [];
  for (const cols of rows) {
    if (Number(cols[iLevel]) !== 2) continue;
    const blockNum = Number(cols[iBlockNum]);
    const words = blockWords.get(blockNum) ?? [];
    const hasText = words.some(w => w.length > 0);

    regions.push({
      x: Number(cols[iLeft]),
      y: Number(cols[iTop]),
      width: Number(cols[iWidth]),
      height: Number(cols[iHeight]),
      kind: hasText ? 'text' : 'image',
    });
  }

  // Sort reading order: top-to-bottom, then left-to-right
  regions.sort((a, b) => a.y - b.y || a.x - b.x);

  // Merge adjacent text blocks (gap < 80px)
  const merged: Region[] = [];
  for (const region of regions) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.kind === 'text' &&
      region.kind === 'text' &&
      region.y - (prev.y + prev.height) < 80
    ) {
      const minX = Math.min(prev.x, region.x);
      const minY = Math.min(prev.y, region.y);
      const maxRight = Math.max(prev.x + prev.width, region.x + region.width);
      const maxBottom = Math.max(prev.y + prev.height, region.y + region.height);
      prev.x = minX;
      prev.y = minY;
      prev.width = maxRight - minX;
      prev.height = maxBottom - minY;
    } else {
      merged.push({ ...region });
    }
  }

  return merged;
}

// ─── Tier 2: Crop ───────────────────────────────────────────────────────────

async function cropRegion(
  imagePath: string,
  region: Region,
  outputPath: string
): Promise<void> {
  await execOrThrow([
    'magick',
    imagePath,
    '-crop',
    `${region.width}x${region.height}+${region.x}+${region.y}`,
    '+repage',
    outputPath,
  ]);
}

// ─── Tier 2: Text Extraction on Crop ────────────────────────────────────────

async function extractRegionText(cropBuffer: Buffer): Promise<string> {
  const { text } = await generateText({
    model: google('gemini-2.5-flash-lite'),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', image: cropBuffer, mediaType: 'image/webp' as const },
          { type: 'text', text: 'Extract all text from this page.' },
        ],
      },
    ],
    system: TEXT_EXTRACTOR_SYSTEM_PROMPT,
  });

  return text;
}

// ─── Per-Page Pipeline ──────────────────────────────────────────────────────

async function extractPage(
  pagesDir: string,
  page: PageInfo
): Promise<{ textFile: string; imageFiles: string[] }> {
  const pageStem = basename(page.file, '.webp');
  const pageSubdir = dirname(page.file);
  const pageDir = join(pagesDir, pageSubdir);
  const imagePath = join(pagesDir, page.file);

  // Tier 1: chop
  const regions = await chopPage(imagePath);

  // Tier 2: crop + extract
  const mdParts: string[] = [];
  const imageFiles: string[] = [];
  let imgCounter = 0;

  for (const region of regions) {
    if (region.kind === 'image') {
      imgCounter++;
      const cropName = `${pageStem}-img-${String(imgCounter).padStart(2, '0')}.webp`;
      const cropPath = join(pageDir, cropName);
      await cropRegion(imagePath, region, cropPath);
      imageFiles.push(join(pageSubdir, cropName));
      mdParts.push(`![[${cropName}]]`);
    } else {
      const cropName = `${pageStem}-text-${String(mdParts.length).padStart(2, '0')}.webp`;
      const cropPath = join(pageDir, cropName);
      await cropRegion(imagePath, region, cropPath);
      const cropBuffer = Buffer.from(await Bun.file(cropPath).arrayBuffer());
      const text = await extractRegionText(cropBuffer);
      mdParts.push(text);
      // clean up temporary text crop
      try { await Bun.file(cropPath).unlink(); } catch { /* best-effort cleanup */ }
    }
  }

  // Reconstruct
  const textFile = join(pageSubdir, `${pageStem}.md`);
  const textPath = join(pagesDir, textFile);
  await Bun.write(textPath, mdParts.join('\n\n'));

  return { textFile, imageFiles };
}

// ─── Top-Level Entry Point ──────────────────────────────────────────────────

export async function extractPages(
  pagesDir: string,
  pages: PageInfo[],
  concurrency: number
): Promise<{ pages: PageInfo[]; errors: PageError[] }> {
  const results = await batchExec(
    pages,
    async (page) => {
      try {
        const { textFile, imageFiles } = await extractPage(pagesDir, page);
        return {
          success: true as const,
          page: { ...page, textFile, imageFiles },
        };
      } catch (err) {
        return {
          success: false as const,
          page,
          error: {
            index: page.index,
            error: `text extraction failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    },
    concurrency
  );

  const pages_: PageInfo[] = [];
  const errors: PageError[] = [];

  for (const result of results) {
    if (result.success) {
      pages_.push(result.page);
    } else {
      errors.push(result.error);
    }
  }

  return { pages: pages_, errors };
}
