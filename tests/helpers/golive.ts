/**
 * Test helper for the go-live gate (agent D): an owner can only provision once the service area is set and the owner confirmed the services / prices /
 * service area as they are NOW (businesses.content_confirmed_*; a later change of any of them makes the confirmation stale). Call it AFTER the knowledge
 * base exists (the confirmation fingerprints it).
 */
import { loadDb, loadPrisma } from './fixtures';

export async function confirmGoLive(businessId: string, serviceArea: string[] = ['Dade County']): Promise<void> {
  const db = await loadDb();
  const prisma = await loadPrisma();
  await prisma.business.update({ where: { id: businessId }, data: { serviceArea } });
  await db.confirmContent(businessId, { kind: 'system' });
}
