import { readFile } from 'node:fs/promises';

export const TASK_IDS = ['load', 'preview', 'captions', 'toolbar', 'form'];

export async function loadPrompt(id, url) {
  const text = await readFile(new URL(`./tasks/${id}.md`, import.meta.url), 'utf8');
  return text.replaceAll('{URL}', url);
}
