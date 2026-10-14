import { useEffect, useRef } from 'react';

export type LocalAttachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  kind: 'image' | 'file';
  url?: string;
};

export type StoredAttachment = Omit<LocalAttachment, 'url'>;

const maxFiles = 5;
const maxFileSize = 10 * 1024 * 1024;
const maxTotalSize = 30 * 1024 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const supportedTypes = new Set([
  ...imageTypes,
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv',
  'application/msword', 'application/rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);
const supportedExtensions = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'csv', 'doc', 'docx', 'rtf',
  'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
]);

export function validateAttachmentBatch(existing: readonly Pick<LocalAttachment, 'size'>[], incoming: readonly File[]): string | undefined {
  if (existing.length + incoming.length > maxFiles) return 'You can attach up to 5 files.';
  for (const file of incoming) {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!supportedTypes.has(file.type.toLowerCase()) && !supportedExtensions.has(extension)) return 'This file type is not supported.';
    if (file.size > maxFileSize) return 'Each file must be 10 MB or smaller.';
  }
  if (existing.reduce((sum, file) => sum + file.size, 0) + incoming.reduce((sum, file) => sum + file.size, 0) > maxTotalSize) {
    return 'Attachments must total 30 MB or less.';
  }
  return undefined;
}

export function prepareAttachments(incoming: readonly File[], existing: readonly LocalAttachment[] = []): { attachments: LocalAttachment[]; error?: string } {
  const error = validateAttachmentBatch(existing, incoming);
  if (error) return { attachments: [], error };
  return {
    attachments: incoming.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      type: file.type,
      size: file.size,
      kind: imageTypes.has(file.type.toLowerCase()) || /\.(png|jpe?g|gif|webp)$/i.test(file.name) ? 'image' : 'file',
      url: URL.createObjectURL(file),
    })),
  };
}

export function attachmentMetadata(attachment: LocalAttachment): StoredAttachment {
  const { id, name, type, size, kind } = attachment;
  return { id, name, type, size, kind };
}

export function useLocalAttachmentPool() {
  const urls = useRef(new Map<string, string>());
  useEffect(() => () => {
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current.clear();
  }, []);

  return {
    addFiles(files: readonly File[], existing: readonly LocalAttachment[] = []) {
      const result = prepareAttachments(files, existing);
      for (const attachment of result.attachments) {
        if (attachment.url) urls.current.set(attachment.id, attachment.url);
      }
      return result;
    },
    release(id: string) {
      const url = urls.current.get(id);
      if (url) URL.revokeObjectURL(url);
      urls.current.delete(id);
    },
  };
}
