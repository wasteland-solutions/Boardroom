import { redirect } from 'next/navigation';
import { desc } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { conversations, cwds } from '@/lib/schema';
import { getSettings } from '@/lib/settings-store';
import { SettingsForm } from '@/components/SettingsForm';

export default async function SettingsPage() {
  const session = await auth();
  if (!session) redirect('/signin');

  const db = getDb();
  const settings = getSettings();
  const allCwds = db.select().from(cwds).all();
  const allConvs = db.select().from(conversations).orderBy(desc(conversations.updatedAt)).all();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="wordmark">B</div>
            <div className="sidebar-title">Boardroom</div>
          </div>
          <div className="sidebar-actions">
            <a className="icon-btn" href="/" title="Back to chat">
              ←
            </a>
          </div>
        </div>
        <div>
          <div className="sidebar-eyebrow">Conversations</div>
          <div className="conv-list">
            {allConvs.map((c) => (
              <a key={c.id} href={`/c/${c.id}`} className="conv-item">
                <div className="title">{c.title ?? 'Untitled'}</div>
                <div className="meta">{c.cwd}</div>
              </a>
            ))}
            {allConvs.length === 0 && <div className="conv-empty">No conversations yet</div>}
          </div>
        </div>
        <div className="sidebar-footer">
          <span className="dot" />
          Agent worker online
        </div>
      </aside>
      <main className="main-panel">
        <SettingsForm initialSettings={settings} initialCwds={allCwds} />
      </main>
    </div>
  );
}
