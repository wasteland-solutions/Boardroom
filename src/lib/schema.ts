import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// A conversation is one Claude Code session. Each conversation holds its own
// `cwd`, `model`, `permissionMode`, and the SDK-side `session_id` we use to
// resume after a restart.
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title'),
  cwd: text('cwd').notNull(),
  provider: text('provider').notNull().default('claude'), // 'claude' | 'codex'
  model: text('model').notNull(),
  permissionMode: text('permission_mode').notNull(), // 'ask' | 'acceptEdits' | 'bypassPermissions'
  sdkSessionId: text('sdk_session_id'),
  // Optional extra instructions appended to claude_code's preset system
  // prompt via the SDK's `systemPrompt: { append: ... }` option. Lets the
  // user give the agent a custom identity / project rules without having
  // to write a CLAUDE.md on the (possibly remote) host.
  systemPromptAppend: text('system_prompt_append'),
  createdAt: integer('created_at', { mode: 'number' }).notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull().default(sql`(unixepoch() * 1000)`),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
});

// Every SDKMessage observed from the Agent SDK is stored here with a monotonic
// per-conversation `seq`. The UI hydrates from this table; SSE reconnects
// replay from this table using `Last-Event-ID`.
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role').notNull(), // 'user' | 'assistant' | 'system' | 'tool_result'
    content: text('content').notNull(), // JSON: content blocks array
    toolCalls: text('tool_calls'), // JSON: extracted tool_use blocks (nullable)
    sdkMessageType: text('sdk_message_type').notNull(), // 'assistant' | 'user' | 'system' | 'result' | 'partial_assistant' | ...
    createdAt: integer('created_at', { mode: 'number' }).notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    convSeqIdx: uniqueIndex('messages_conv_seq_idx').on(t.conversationId, t.seq),
    convCreatedIdx: index('messages_conv_created_idx').on(t.conversationId, t.createdAt),
  }),
);

// Outstanding canUseTool requests. A row is inserted when the broker creates
// a pending Promise, and updated to 'allowed' / 'denied' / 'expired' when the
// user responds or the configured timeout fires.
export const pendingPermissions = sqliteTable(
  'pending_permissions',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    input: text('input').notNull(), // JSON
    status: text('status').notNull(), // 'pending' | 'allowed' | 'denied' | 'expired'
    createdAt: integer('created_at', { mode: 'number' }).notNull().default(sql`(unixepoch() * 1000)`),
    resolvedAt: integer('resolved_at', { mode: 'number' }),
  },
  (t) => ({
    convStatusIdx: index('pending_conv_status_idx').on(t.conversationId, t.status),
  }),
);

// App-wide settings. Single-row k/v store with JSON values.
// Keys:
//   - default_model             string
//   - default_permission_mode   'ask' | 'acceptEdits' | 'bypassPermissions'
//   - mcp_servers               Record<string, McpServerConfig>
//   - permission_timeout_ms     number (0 = hold forever)
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON
});

// Allowed working directories that a new conversation may be bound to.
export const cwds = sqliteTable('cwds', {
  path: text('path').primaryKey(),
  label: text('label').notNull(),
  createdAt: integer('created_at', { mode: 'number' }).notNull().default(sql`(unixepoch() * 1000)`),
});

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type PendingPermission = typeof pendingPermissions.$inferSelect;
export type NewPendingPermission = typeof pendingPermissions.$inferInsert;
export type Cwd = typeof cwds.$inferSelect;
