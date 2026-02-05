import { join, basename } from 'node:path';
import { unlink } from 'node:fs/promises';
import { exec, batchExec } from './exec';
import { getImageDimensions } from './image-dimensions';
import type { PageInfo, PageError } from '../types';

export async function processPages(
  pagesDir: string,
  inputPages: PageInfo[],
  concurrency: number
): Promise<{ pages: PageInfo[]; errors: PageError[] }> {
  const results = await batchExec(
    inputPages,
    async (page) => {
      const inputPath = join(pagesDir, page.file);
      const outputFile = basename(page.file, '.png') + '.webp';
      const outputPath = join(pagesDir, outputFile);

      const result = await exec([
        'magick', inputPath,
        '-colorspace', 'Gray',
        '-contrast-stretch', '1%x1%',
        '-deskew', '40%',
        '-fuzz', '5%', '-trim', '+repage',
        '-bordercolor', 'white', '-border', '20',
        '-unsharp', '0x1+0.5+0.05',
        '-define', 'webp:lossless=true',
        outputPath,
      ]);

      if (result.exitCode !== 0) {
        return {
          success: false as const,
          error: { index: page.index, error: result.stderr || 'magick processing failed' },
        };
      }

      try {
        const dims = await getImageDimensions(outputPath);
        await unlink(inputPath);
        return {
          success: true as const,
          page: { index: page.index, file: outputFile, width: dims.width, height: dims.height },
        };
      } catch (err) {
        return {
          success: false as const,
          error: { index: page.index, error: err instanceof Error ? err.message : 'failed to read processed output' },
        };
      }
    },
    concurrency
  );

  const pages: PageInfo[] = [];
  const errors: PageError[] = [];

  for (const result of results) {
    if (result.success) {
      pages.push(result.page);
    } else {
      errors.push(result.error);
    }
  }

  return { pages, errors };
}
