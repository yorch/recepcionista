import { PageSkeleton } from '@/components/ui/skeleton';
import { getT } from '@/lib/i18n/server';

export default async function DashboardLoading() {
  return <PageSkeleton label={(await getT())('error.dashboard.loading')} />;
}
