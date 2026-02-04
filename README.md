# doc2pages

Document to scanned pages converter. Converts PDFs and images to numbered page images with a manifest.

## Features

- PDF rendering via `pdftoppm` (Poppler)
- Image normalization and format conversion
- Natural page sorting for image folders
- JSON manifest with page dimensions and metadata

## Usage

```bash
doc2pages <input> <output> [options]
```

### Arguments

- `input` - Path to PDF file, image file, or folder of images
- `output` - Output directory for pages and manifest

### Options

- `--dpi <number>` - Resolution for PDF rendering (default: 300)
- `--format <png|jpg>` - Output image format (default: png)
- `--concurrency <n>` - Number of parallel processes (default: 20)

### Examples

```bash
# Convert PDF to PNG pages at 300 DPI
doc2pages book.pdf ./output --dpi 300

# Convert folder of scans to JPG
doc2pages ./scans ./output --format jpg

# Convert single image
doc2pages cover.jpg ./output
```

## Output Structure

```
output/
├── pages/
│   ├── page-0001.png
│   ├── page-0002.png
│   └── ...
└── manifest.json
```

## Manifest Format

```json
{
  "source": "book.pdf",
  "pageCount": 42,
  "dpi": 300,
  "format": "png",
  "pages": [
    {"index": 1, "file": "page-0001.png", "width": 2550, "height": 3300}
  ],
  "errors": [],
  "toolchain": {"renderer": "pdftoppm", "version": "0.86.1"}
}
```

## Docker

### Build

```bash
docker build -t doc2pages .
```

### Run

```bash
docker run -v /path/to/input:/input -v /path/to/output:/output \
  doc2pages /input/book.pdf /output --dpi 300
```

## Requirements

- Bun runtime
- poppler-utils (for PDF rendering)
- ImageMagick (for image conversion)

## Future Extensions

- DJVU support via `ddjvu`
- Office formats via LibreOffice headless
- MuPDF as fallback renderer
