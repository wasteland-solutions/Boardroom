'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { memo } from 'react';

// Thin wrapper around react-markdown with GFM (tables, strikethrough,
// task lists) and syntax highlighting for fenced code blocks.
// Memoized so re-renders from streaming deltas don't re-parse unchanged
// message blocks.
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
      {children}
    </ReactMarkdown>
  );
});
