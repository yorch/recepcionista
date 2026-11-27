import type { Metadata } from 'next';
import { LegalDocument, legalMetadata } from '@/components/legal/legal-document';

export const dynamic = 'force-dynamic'; // the language and the published version come from the request

export async function generateMetadata(): Promise<Metadata> { return legalMetadata('sms_terms'); }

export default function Page() { return <LegalDocument slug="sms_terms" />; }
