import { describe, expect, it } from 'vitest';
import { attachmentMetadata, validateAttachmentBatch, type LocalAttachment } from '../docs/prototypes/2026-10-02/team-workbench-v3/src/local-attachments';

function file(name: string, type: string, size: number) {
  return { name, type, size } as File;
}

describe('local attachment limits and metadata', () => {
  it('accepts common image and document files within the per-file and total limits', () => {
    expect(validateAttachmentBatch([], [file('photo.webp', 'image/webp', 10 * 1024 * 1024), file('notes.md', 'text/markdown', 10 * 1024 * 1024)])).toBeUndefined();
  });

  it('rejects unsupported types, files over 10 MB, more than five files, and totals over 30 MB', () => {
    expect(validateAttachmentBatch([], [file('archive.zip', 'application/zip', 100)])).toBe('This file type is not supported.');
    expect(validateAttachmentBatch([], [file('large.pdf', 'application/pdf', 10 * 1024 * 1024 + 1)])).toBe('Each file must be 10 MB or smaller.');
    expect(validateAttachmentBatch(Array.from({ length: 5 }, () => ({ size: 1 })), [file('one.txt', 'text/plain', 1)])).toBe('You can attach up to 5 files.');
    expect(validateAttachmentBatch([], Array.from({ length: 4 }, (_, index) => file(`${index}.pdf`, 'application/pdf', 8 * 1024 * 1024)))).toBe('Attachments must total 30 MB or less.');
  });

  it('stores file metadata without object URLs or file contents', () => {
    const live: LocalAttachment = { id: 'a1', name: 'photo.png', type: 'image/png', size: 10, kind: 'image', url: 'blob:session-preview' };
    const metadata = attachmentMetadata(live);
    expect(metadata).toEqual({ id: 'a1', name: 'photo.png', type: 'image/png', size: 10, kind: 'image' });
    expect(JSON.stringify(metadata)).not.toContain('blob:');
    expect(JSON.stringify(metadata)).not.toContain('base64');
  });
});
