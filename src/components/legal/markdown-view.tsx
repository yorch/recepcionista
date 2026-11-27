import { parseMarkdown, type Block, type Inline } from '@/lib/markdown';

/**
 * Renders the safe markdown tree as React elements. No raw HTML is ever injected: every string goes through React's escaping, and every href was
 * accepted by `safeHref`. External links open with rel="noopener noreferrer nofollow".
 */
function Inlines({ c }: { c: readonly Inline[] }) {
  return (
    <>
      {c.map((x, i) => {
        switch (x.t) {
          case 'text': return <span key={i}>{x.v}</span>;
          case 'strong': return <strong key={i} className="font-semibold text-white"><Inlines c={x.c} /></strong>;
          case 'em': return <em key={i}><Inlines c={x.c} /></em>;
          case 'code': return <code key={i} className="rounded bg-raised px-1 py-0.5 font-mono text-[0.9em] text-soft">{x.v}</code>;
          case 'link': return x.external
            ? <a key={i} href={x.href} target="_blank" rel="noopener noreferrer nofollow" className="text-brand-soft underline underline-offset-2 hover:text-brand-hover"><Inlines c={x.c} /></a>
            : <a key={i} href={x.href} className="text-brand-soft underline underline-offset-2 hover:text-brand-hover"><Inlines c={x.c} /></a>;
        }
      })}
    </>
  );
}

const HEADING_CLASS: Record<number, string> = {
  1: 'mt-8 text-[26px] font-semibold tracking-[-0.02em] text-white',
  2: 'mt-8 text-[20px] font-semibold text-white',
  3: 'mt-6 text-[17px] font-semibold text-white',
  4: 'mt-5 text-[15px] font-semibold text-white',
  5: 'mt-4 text-[14px] font-semibold text-white',
  6: 'mt-4 text-[13px] font-semibold uppercase tracking-wider text-soft',
};

function Blocks({ blocks }: { blocks: readonly Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h': {
            const Tag = `h${b.level}` as 'h1';
            return <Tag key={i} className={HEADING_CLASS[b.level]}><Inlines c={b.c} /></Tag>;
          }
          case 'p': return <p key={i} className="mt-3"><Inlines c={b.c} /></p>;
          case 'ul': return <ul key={i} className="mt-3 list-disc space-y-1.5 pl-5">{b.items.map((it, j) => <li key={j}><Inlines c={it} /></li>)}</ul>;
          case 'ol': return <ol key={i} start={b.start} className="mt-3 list-decimal space-y-1.5 pl-5">{b.items.map((it, j) => <li key={j}><Inlines c={it} /></li>)}</ol>;
          case 'quote': return <blockquote key={i} className="mt-3 border-l-2 border-line-3 pl-4 text-mute"><Blocks blocks={b.c} /></blockquote>;
          case 'pre': return <pre key={i} className="mt-3 overflow-x-auto rounded-xl border border-line bg-sunken p-3 font-mono text-[13px] text-soft">{b.v}</pre>;
          case 'hr': return <hr key={i} className="my-6 border-line" />;
        }
      })}
    </>
  );
}

export function MarkdownView({ source, className }: { source: string; className?: string }) {
  return <div className={className}><Blocks blocks={parseMarkdown(source)} /></div>;
}
