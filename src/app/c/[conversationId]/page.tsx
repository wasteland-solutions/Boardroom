import { notFound, redirect } from 'next/navigation';
import { eq, desc, asc } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { conversations, cwds, messages } from '@/lib/schema';
import { ChatShell } from '@/components/ChatShell';

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<{ mode?: string }>;
}) {
  const session = await auth();
  if (!session) redirect('/signin');

  const { conversationId } = await params;
  const { mode } = await searchParams;
  const initialMode = mode === 'terminal' ? 'terminal' : 'chat';
  const db = getDb();
  const allConvs = db.select().from(conversations).orderBy(desc(conversations.updatedAt)).all();
  const allCwds = db.select().from(cwds).all();

  if (conversationId === 'new') {
    return <ChatShell conversations={allConvs} cwds={allCwds} current={null} initialMessages={[]} initialMode="chat" />;
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
    <ChatShell conversations={allConvs} cwds={allCwds} current={current} initialMessages={initialMessages} initialMode={initialMode as 'chat' | 'terminal'} />
  );
}
