import Link from 'next/link';
import { buttonClass } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function DashboardNotFound() {
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-16 sm:px-6">
      <Card className="p-8 text-center">
        <h1 className="text-[20px] font-semibold text-white">Page not found</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-mute">
          That page does not exist, or you do not have access to it.
        </p>
        <Link href="/dashboard" className={buttonClass('primary', 'mt-5')}>Back to Today</Link>
      </Card>
    </main>
  );
}
