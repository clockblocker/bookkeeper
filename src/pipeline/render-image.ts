import { join, basename, extname } from 'node:path';
import { mkdir, copyFile } from 'node:fs/promises';
import { exec, getCommandVersion, batchExec } from './exec';
import { getImageDimensions } from './image-dimensions';
import type { RenderOptions, PageInfo, PageError, Toolchain } from '../types';

interface ImageRenderResult {
  pages: PageInfo[];
  errors: PageError[];
  toolchain: Toolchain;
}

function formatPageNumber(index: number, total: number): string {
  const digits = Math.max(4, String(total).length);
  return String(index).padStart(digits, '0');
}

export async function renderImages(
  imagePaths: string[],
  outputDir: string,
  options: RenderOptions
): Promise<ImageRenderResult> {
  const pagesDir = join(outputDir, 'pages');
  await mkdir(pagesDir, { recursive: true });

  const version = await getCommandVersion('convert');
  const toolchain: Toolchain = { renderer: 'imagemagick', version };

  // Prepare work items with pre-computed paths
  const workItems = imagePaths.map((srcPath, i) => {
    const pageNum = i + 1;
    const paddedNum = formatPageNumber(pageNum, imagePaths.length);
    const outputFile = `page-${paddedNum}.${options.format}`;
    const destPath = join(pagesDir, outputFile);
    return { srcPath, pageNum, outputFile, destPath };
  });

  // Process images in parallel batches
  const results = await batchExec(
    workItems,
    async (item) => {
      try {
        const srcExt = extname(item.srcPath).toLowerCase();
        const needsConvert = srcExt !== `.${options.format}`;

        if (needsConvert) {
          const result = await exec(['convert', item.srcPath, item.destPath]);
          if (result.exitCode !== 0) {
            throw new Error(result.stderr);
          }
        } else {
          await copyFile(item.srcPath, item.destPath);
        }

        const dims = await getImageDimensions(item.destPath);
        return {
          success: true as const,
          page: {
            index: item.pageNum,
            file: item.outputFile,
            width: dims.width,
            height: dims.height,
          },
        };
      } catch (err) {
        return {
          success: false as const,
          error: {
            index: item.pageNum,
            error: err instanceof Error ? err.message : 'unknown error',
          },
        };
      }
    },
    options.concurrency
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

  return { pages, errors, toolchain };
}
