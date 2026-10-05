import { useState, type KeyboardEvent } from 'react';
import { Button } from '../../../../../src/local/web/src/components/ui/button';
import { Input } from '../../../../../src/local/web/src/components/ui/input';
import type { LocalAttachment } from './local-attachments';

export type AttachmentListProps = {
  attachments: readonly LocalAttachment[];
  onRemove?: (id: string) => void;
  removable?: boolean;
};

export type ConversationComposerProps = {
  projectId: string;
  recipient?: string;
  draft: string;
  setDraft: (value: string) => void;
  appendDictation: (value: string) => void;
  attachments: LocalAttachment[];
  addFiles: (files: File[]) => void;
  removeAttachment: (id: string) => void;
  send: () => void;
  active: boolean;
  error?: string;
};

export function shouldSendOnEnter(event: Pick<KeyboardEvent<HTMLTextAreaElement>, 'key' | 'shiftKey' | 'nativeEvent'>) {
  return event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229;
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentGlyph({ kind }: { kind: LocalAttachment['kind'] }) {
  return kind === 'image'
    ? <svg className="conversation-attachment-icon grid flex-[none] place-items-center w-10.5 h-10.5 rounded-[4px] object-cover bg-[#f0f2ed] text-[#65705d]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
    : <svg className="conversation-attachment-icon grid flex-[none] place-items-center w-10.5 h-10.5 rounded-[4px] object-cover bg-[#f0f2ed] text-[#65705d]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h7m-7 4h7"/></svg>;
}

export function AttachmentList({ attachments, onRemove, removable = false }: AttachmentListProps) {
  const [failedPreviews, setFailedPreviews] = useState<Set<string>>(() => new Set());
  if (!attachments.length) return null;
  return <div className="conversation-attachments flex flex-wrap gap-1.5 min-w-0" aria-label="Attachments">
    {attachments.map((attachment) => <div className="conversation-attachment flex items-center gap-1.75 min-w-0 max-w-full pt-1 pr-1.5 pb-1 pl-1.5 border border-[#e6e8e2] rounded-[6px] bg-[#fafbf9]" key={attachment.id}>
      {attachment.kind === 'image' && attachment.url && !failedPreviews.has(attachment.id)
        ? <img className="conversation-attachment-preview grid flex-[none] place-items-center w-10.5 h-10.5 rounded-[4px] object-cover bg-[#f0f2ed] text-[#65705d]" src={attachment.url} alt={attachment.name} onError={() => setFailedPreviews((items) => new Set(items).add(attachment.id))}/>
        : <AttachmentGlyph kind={attachment.kind}/>}
      <span className="conversation-attachment-copy grid min-w-0 [&_strong]:overflow-hidden [&_strong]:max-w-[140px] [&_strong]:text-[#4c5148] [&_strong]:text-[11px] [&_strong]:font-semibold [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_small]:text-[#757a71] [&_small]:text-[10px]"><strong title={attachment.name}>{attachment.name}</strong><small>{attachment.kind === 'image' && (!attachment.url || failedPreviews.has(attachment.id)) ? 'Preview unavailable' : formatSize(attachment.size)}</small></span>
      {removable && onRemove && <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${attachment.name}`} title={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.id)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></Button>}
    </div>)}
  </div>;
}

export function ConversationComposer({ draft, setDraft, send, active, recipient = "Master" }: ConversationComposerProps) {
  return <div className="conversation-composer flex min-h-13 min-w-0 shrink-0 items-center gap-1 rounded-full border border-border bg-background px-1.5 py-1.25 shadow-sm focus-within:border-ring [&>button]:size-10 [&>button]:shrink-0 [&>button]:rounded-full [&>button]:p-2.5 [&_svg]:size-4.5 [&_input]:h-9.5 [&_input]:w-0 [&_input]:min-w-0 [&_input]:flex-1 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:shadow-none [&_input]:text-sm [&_input]:focus-visible:ring-0">
    <Button type="button" variant="ghost" size="icon" className="composer-tool border-0 bg-transparent text-muted-foreground shadow-none hover:bg-muted hover:text-foreground" aria-label="Attach file" title="Attach file">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
    </Button>
    <Input aria-label={`Message ${recipient}`} placeholder={`Message ${recipient}…`} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
        event.preventDefault(); if (active && draft.trim()) send();
      }
    }}/>
    <Button type="button" variant="ghost" size="icon" className="composer-tool border-0 bg-transparent text-muted-foreground shadow-none hover:bg-muted hover:text-foreground" aria-label="Voice input" title="Voice input">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>
    </Button>
    <Button type="button" size="icon" className="composer-send border-0 bg-primary text-primary-foreground disabled:opacity-40" aria-label="Send message" title="Send message" disabled={!active || !draft.trim()} onClick={send}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>
    </Button>
  </div>;
}
