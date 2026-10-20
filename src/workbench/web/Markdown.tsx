import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return <div className="min-w-0 max-w-full wrap-anywhere text-sm leading-relaxed [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold">
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
      p: ({ children }) => <p className="min-w-0 whitespace-pre-wrap wrap-anywhere">{children}</p>,
      pre: ({ children }) => <pre className="my-3 max-w-full overflow-x-auto rounded-md bg-muted p-3 text-xs whitespace-pre">{children}</pre>,
      table: ({ children }) => <div className="my-3 max-w-full overflow-x-auto"><table className="w-full border-collapse text-left [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2">{children}</table></div>,
    }}>{children}</ReactMarkdown>
  </div>;
});
