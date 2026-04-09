import { notFound, redirect } from 'next/navigation';
import { eq, desc, asc } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { conversations, cwds, messages } from '@/lib/schema';
import { ChatShell } from '@/components/ChatShell';

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const session = await auth();
  if (!session) redirect('/signin');

  const { conversationId } = await params;
  const db = getDb();
  const allConvs = db.select().from(conversations).orderBy(desc(conversations.updatedAt)).all();
  const allCwds = db.select().from(cwds).all();

  if (conversationId === 'new') {
    return <ChatShell conversations={allConvs} cwds={allCwds} current={null} initialMessages={[]} />;
  }

  const current = allConvs.find((c) => c.id === conversationId);
  if (!current) notFound();

  const rawMessages = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.seq))
    .all();
  const initialMessages = rawMessages.map((r) => ({
    ...r,
    content: JSON.parse(r.content),
    toolCalls: r.toolCalls ? JSON.parse(r.toolCalls) : null,
  }));

  return (
    <ChatShell conversations={allConvs} cwds={allCwds} current={current} initialMessages={initialMessages} />
  );
}
