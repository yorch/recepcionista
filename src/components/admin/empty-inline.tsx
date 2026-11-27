import { Card } from '@/components/ui/card';

/** A meaningful empty state inside a console page (no call to action: the page itself is the next step). */
export function EmptyStateInline({ title, body }: { title: string; body: string }) {
  return (
    <Card className="px-6 py-8 text-center">
      <h2 className="text-[15px] font-semibold text-white">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-mute">{body}</p>
    </Card>
  );
}
