import { redirect } from 'next/navigation';
import { desc } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { conversations } from '@/lib/schema';

export default async function IndexPage() {
  const session = await auth();
  if (!session) redirect('/signin');

  const db = getDb();
  const latest = db.select().from(conversations).orderBy(desc(conversations.updatedAt)).limit(1).get();
  if (latest) redirect(`/c/${latest.id}`);
  redirect('/c/new');
}
