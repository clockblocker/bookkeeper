import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { DetectionResult, InputType } from '../types';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.webp']);
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

async function isPdfFile(path: string): Promise<boolean> {
  const ext = extname(path).toLowerCase();
  if (ext !== '.pdf') return false;

  try {
    const file = Bun.file(path);
    const buffer = await file.slice(0, 4).arrayBuffer();
    const header = Buffer.from(buffer);
    return header.equals(PDF_MAGIC);
  } catch {
    return false;
  }
}

function isImageFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

export async function detectInput(inputPath: string): Promise<DetectionResult> {
  const stats = await stat(inputPath);

  if (stats.isFile()) {
    if (await isPdfFile(inputPath)) {
      return { type: 'pdf', files: [inputPath] };
    }
    if (isImageFile(inputPath)) {
      return { type: 'image', files: [inputPath] };
    }
    return { type: 'unsupported', files: [] };
  }

  if (stats.isDirectory()) {
    const entries = await readdir(inputPath);
    const images = entries
      .filter((f) => isImageFile(f))
      .sort(naturalSort)
      .map((f) => join(inputPath, f));

    if (images.length > 0) {
      return { type: 'image-folder', files: images };
    }

    const pdfs = entries.filter((f) => extname(f).toLowerCase() === '.pdf');
    if (pdfs.length === 1) {
      const pdfPath = join(inputPath, pdfs[0]);
      if (await isPdfFile(pdfPath)) {
        return { type: 'pdf', files: [pdfPath] };
      }
    }

    return { type: 'unsupported', files: [] };
  }

  return { type: 'unsupported', files: [] };
}
