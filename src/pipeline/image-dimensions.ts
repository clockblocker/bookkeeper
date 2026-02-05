import { open } from 'node:fs/promises';
import { exec } from './exec';

export interface ImageDimensions {
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOI = 0xffd8;

/**
 * Read PNG dimensions from the IHDR chunk (bytes 16-23).
 * Layout: 8-byte signature + 4-byte chunk length + 4-byte "IHDR" + 4-byte width + 4-byte height
 */
async function readPngDimensions(filePath: string): Promise<ImageDimensions | null> {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(24);
    const { bytesRead } = await fh.read(buf, 0, 24, 0);
    if (bytesRead < 24) return null;

    // Verify PNG signature
    if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height };
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/**
 * Read JPEG dimensions by scanning for SOF0 (0xFFC0) or SOF2 (0xFFC2) marker.
 * Reads up to 64KB to find the frame marker.
 */
async function readJpegDimensions(filePath: string): Promise<ImageDimensions | null> {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, 65536, 0);
    if (bytesRead < 4) return null;

    // Verify JPEG SOI marker
    if (buf.readUInt16BE(0) !== JPEG_SOI) return null;

    let offset = 2;
    while (offset + 9 < bytesRead) {
      // Each marker starts with 0xFF
      if (buf[offset] !== 0xff) return null;

      const marker = buf[offset + 1];

      // Skip padding 0xFF bytes
      if (marker === 0xff) {
        offset++;
        continue;
      }

      // SOF0 or SOF2 — contains dimensions
      if (marker === 0xc0 || marker === 0xc2) {
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        return { width, height };
      }

      // SOS marker (start of scan) — dimensions must appear before this
      if (marker === 0xda) return null;

      // Skip other markers: read segment length and advance
      const segmentLength = buf.readUInt16BE(offset + 2);
      offset += 2 + segmentLength;
    }

    return null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/**
 * Fallback: spawn `identify` to read dimensions for any image format.
 */
async function readDimensionsViaIdentify(filePath: string): Promise<ImageDimensions> {
  const result = await exec(['identify', '-format', '%w %h', filePath]);
  if (result.exitCode !== 0) {
    return { width: 0, height: 0 };
  }
  const [width, height] = result.stdout.trim().split(' ').map(Number);
  return { width: width || 0, height: height || 0 };
}

/**
 * Get image dimensions by reading binary headers (PNG/JPEG) or falling back to `identify`.
 */
export async function getImageDimensions(filePath: string): Promise<ImageDimensions> {
  const lower = filePath.toLowerCase();

  if (lower.endsWith('.png')) {
    const dims = await readPngDimensions(filePath);
    if (dims) return dims;
  } else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    const dims = await readJpegDimensions(filePath);
    if (dims) return dims;
  }

  return readDimensionsViaIdentify(filePath);
}
