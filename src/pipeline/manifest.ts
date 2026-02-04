import { join } from 'node:path';
import type { Manifest, PageInfo, PageError, Toolchain } from '../types';

export interface ManifestInput {
  source: string;
  dpi: number;
  format: string;
  pages: PageInfo[];
  errors: PageError[];
  toolchain: Toolchain;
}

export function createManifest(input: ManifestInput): Manifest {
  return {
    source: input.source,
    pageCount: input.pages.length + input.errors.length,
    dpi: input.dpi,
    format: input.format,
    pages: input.pages,
    errors: input.errors,
    toolchain: input.toolchain,
  };
}

export async function writeManifest(
  outputDir: string,
  manifest: Manifest
): Promise<void> {
  const manifestPath = join(outputDir, 'manifest.json');
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
}
