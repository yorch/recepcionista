'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import type { ApiResult, KnowledgeBase } from '@/lib/types';

export function KnowledgeEditor({
  businessId, initialPrompt, initialScript,
}: { businessId: string; initialPrompt: string; initialScript: string }) {
  const router = useRouter();
  const [prompt] = useState(initialPrompt);
  const [script, setScript] = useState(initialScript);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/knowledge`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ call_script: script }),
      });
      const json = (await res.json()) as ApiResult<KnowledgeBase>;
      if (!json.ok) throw new Error(json.error);
      toast.success('Saved — she will use this on the next call');
      router.refresh();
      setOpen(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHead
        title="Her script"
        subtitle="The words she opens with"
        right={
          <button onClick={() => setOpen((o) => !o)} className="text-[11px] text-[#ff8f5e] hover:underline">
            {open ? 'hide' : 'edit'}
          </button>
        }
      />
      <div className="p-4">
        {open ? (
          <>
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              rows={9}
              className="w-full resize-y rounded-xl border border-[#26313f] bg-[#080b10] p-3 text-[12px] leading-relaxed text-[#cbd7e6] outline-none focus:border-[#ff6b35]/60"
            />
            <div className="mt-3 flex gap-2">
              <Button onClick={save} disabled={busy} className="flex-1">{busy ? 'Saving…' : 'Save'}</Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
            <details className="mt-4">
              <summary className="cursor-pointer text-[10.5px] text-[#5a6b80] hover:text-[#8b98ab]">Full system prompt</summary>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-[#080b10] p-3 text-[10.5px] leading-relaxed text-[#6b7b91]">
                {prompt}
              </pre>
            </details>
          </>
        ) : (
          <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-[#8b98ab]">{script}</p>
        )}
      </div>
    </Card>
  );
}
