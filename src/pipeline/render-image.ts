import { join, basename, extname } from 'node:path';
import { mkdir, copyFile } from 'node:fs/promises';
import { exec, getCommandVersion } from './exec';
import type { RenderOptions, PageInfo, PageError, Toolchain } from '../types';

interface ImageRenderResult {
  pages: PageInfo[];
  errors: PageError[];
  toolchain: Toolchain;
}

async function getImageDimensions(imagePath: string): Promise<{ width: number; height: number }> {
  const result = await exec(['identify', '-format', '%w %h', imagePath]);
  if (result.exitCode !== 0) {
    return { width: 0, height: 0 };
  }
  const [width, height] = result.stdout.trim().split(' ').map(Number);
  return { width: width || 0, height: height || 0 };
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

  const pages: PageInfo[] = [];
  const errors: PageError[] = [];
  const version = await getCommandVersion('convert');
  const toolchain: Toolchain = { renderer: 'imagemagick', version };

  for (let i = 0; i < imagePaths.length; i++) {
    const srcPath = imagePaths[i];
    const pageNum = i + 1;
    const paddedNum = formatPageNumber(pageNum, imagePaths.length);
    const outputFile = `page-${paddedNum}.${options.format}`;
    const destPath = join(pagesDir, outputFile);

    try {
      const srcExt = extname(srcPath).toLowerCase();
      const needsConvert = srcExt !== `.${options.format}`;

      if (needsConvert) {
        // Use ImageMagick to convert
        const result = await exec(['convert', srcPath, destPath]);
        if (result.exitCode !== 0) {
          throw new Error(result.stderr);
        }
      } else {
        await copyFile(srcPath, destPath);
      }

      const dims = await getImageDimensions(destPath);
      pages.push({
        index: pageNum,
        file: outputFile,
        width: dims.width,
        height: dims.height,
      });
    } catch (err) {
      errors.push({
        index: pageNum,
        error: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  return { pages, errors, toolchain };
}
