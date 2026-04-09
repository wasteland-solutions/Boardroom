import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { cwds } from '@/lib/schema';
import { getSettings } from '@/lib/settings-store';
import { SettingsForm } from '@/components/SettingsForm';

export default async function SettingsPage() {
  const session = await auth();
  if (!session) redirect('/signin');

  const db = getDb();
  const settings = getSettings();
  const allCwds = db.select().from(cwds).all();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-title">Settings</div>
          <div className="sidebar-actions">
            <a className="icon-btn" href="/" title="Back">
              ←
            </a>
          </div>
        </div>
      </aside>
      <main className="chat">
        <div className="messages">
          <SettingsForm initialSettings={settings} initialCwds={allCwds} />
        </div>
      </main>
    </div>
  );
}
