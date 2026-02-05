export type InputType = 'pdf' | 'image' | 'image-folder' | 'unsupported';

export interface DetectionResult {
  type: InputType;
  files: string[];
}

export interface RenderOptions {
  dpi: number;
  concurrency: number;
}

export interface PageInfo {
  index: number;
  file: string;
  width: number;
  height: number;
}

export interface PageError {
  index: number;
  error: string;
}

export interface Toolchain {
  renderer: string;
  version: string;
}

export interface Manifest {
  source: string;
  pageCount: number;
  dpi: number;
  format: string;
  pages: PageInfo[];
  errors: PageError[];
  toolchain: Toolchain;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
