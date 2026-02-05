import { join, basename } from 'node:path';
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { batchExec } from './exec';
import type { PageInfo, PageError } from '../types';

const SYSTEM_PROMPT = `You are a strict OCR engine. Extract all text from the provided page image and output it as clean Markdown.

Rules:
- Output ONLY the extracted text as Markdown. No preamble, no explanations.
- Preserve the original language of the text exactly as it appears.
- Use appropriate Markdown formatting (headings, lists, tables) to reflect the document structure.
- Do not describe images, diagrams, or decorative elements.
- If the page is blank or contains no readable text, output exactly: <!-- blank page -->`;

export async function extractPages(
  pagesDir: string,
  pages: PageInfo[],
  concurrency: number
): Promise<{ pages: PageInfo[]; errors: PageError[] }> {
  const results = await batchExec(
    pages,
    async (page) => {
      const imagePath = join(pagesDir, page.file);
      const textFile = basename(page.file, '.webp') + '.md';
      const textPath = join(pagesDir, textFile);

      try {
        const imageData = await Bun.file(imagePath).arrayBuffer();

        const { text } = await generateText({
          model: google('gemini-2.5-flash-lite'),
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  image: Buffer.from(imageData),
                  mediaType: 'image/webp',
                },
                {
                  type: 'text',
                  text: 'Extract all text from this page.',
                },
              ],
            },
          ],
          system: SYSTEM_PROMPT,
        });

        await Bun.write(textPath, text);

        return {
          success: true as const,
          page: { ...page, textFile },
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
      pages_.push(result.page);
      errors.push(result.error);
    }
  }

  return { pages: pages_, errors };
}
