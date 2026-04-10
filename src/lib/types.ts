// Shared wire types between Next.js, the agent worker, and the browser.

export type PermissionMode = 'ask' | 'acceptEdits' | 'bypassPermissions';

export type Provider = 'claude' | 'codex';

export type ModelId = 'claude-opus-4-6' | 'claude-sonnet-4-6' | 'claude-haiku-4-5' | 'o4-mini' | 'o3' | 'gpt-4.1';

// `api_key`     — use the ANTHROPIC_API_KEY env var. Billed to your Anthropic
//                 Console account.
// `claude_code` — use the credentials stored by the Claude Code CLI (run
//                 `claude login` on the host). Billed to your Claude Max /
//                 Pro subscription. The worker strips ANTHROPIC_API_KEY from
//                 the environment before spawning the CLI child so the CLI
//                 falls back to its own stored OAuth token.
export type AuthMode = 'api_key' | 'claude_code';

export const CLAUDE_MODELS: ModelId[] = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

export const CODEX_MODELS: ModelId[] = [
  'o4-mini',
  'o3',
  'gpt-4.1',
];

export const ALL_MODELS: ModelId[] = [...CLAUDE_MODELS, ...CODEX_MODELS];

// Keep DEFAULT_MODELS for backwards compat (used in zod schemas).
export const DEFAULT_MODELS = ALL_MODELS;

// --- Settings (persisted as JSON in the `settings` table) ---

export interface AppSettings {
  authMode: AuthMode;
  // Pasted in Settings → Credentials. Stored in SQLite; overrides the
  // ANTHROPIC_API_KEY env var. Never shipped to the browser except through
  // the authenticated settings API for the owner to edit.
  anthropicApiKey: string;
  // A long-lived Claude Code OAuth token produced by running
  // `claude setup-token` on a machine with an active Claude subscription.
  // Injected as CLAUDE_CODE_OAUTH_TOKEN into the spawned CLI child.
  claudeCodeOauthToken: string;
  defaultModel: ModelId;
  defaultPermissionMode: PermissionMode;
  mcpServers: Record<string, McpServerConfig>;
  permissionTimeoutMs: number; // 0 = hold forever
  // OpenAI API key for Codex conversations (pasted in Settings, stored
  // encrypted in SQLite like the Anthropic key).
  openaiApiKey: string;
}

// Mirrors the shape expected by Claude Agent SDK's `mcpServers` option.
export type McpServerConfig =
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      type: 'sse';
      url: string;
      headers?: Record<string, string>;
    };

export const DEFAULT_SETTINGS: AppSettings = {
  authMode: 'api_key',
  anthropicApiKey: '',
  claudeCodeOauthToken: '',
  defaultModel: 'claude-opus-4-6',
  defaultPermissionMode: 'ask',
  mcpServers: {},
  permissionTimeoutMs: 5 * 60 * 1000,
  openaiApiKey: '',
};

// --- Server → Client SSE frames ---

export type StreamFrame =
  | { type: 'hydrated'; lastSeq: number }
  | {
      type: 'partial_assistant_text';
      conversationId: string;
      seq: number;
      delta: string;
      messageId: string;
    }
  | {
      type: 'assistant_message';
      conversationId: string;
      seq: number;
      messageId: string;
      content: unknown; // Anthropic ContentBlock[]
    }
  | {
      type: 'user_message';
      conversationId: string;
      seq: number;
      messageId: string;
      content: unknown;
    }
  | {
      type: 'tool_use';
      conversationId: string;
      seq: number;
      toolUseId: string;
      name: string;
      input: unknown;
    }
  | {
      type: 'tool_result';
      conversationId: string;
      seq: number;
      toolUseId: string;
      content: unknown;
      isError: boolean;
    }
  | {
      type: 'permission_request';
      conversationId: string;
      seq: number;
      requestId: string;
      toolName: string;
      input: unknown;
      suggestions?: unknown;
    }
  | {
      type: 'permission_resolved';
      conversationId: string;
      seq: number;
      requestId: string;
      decision: 'allow' | 'deny' | 'expired';
    }
  | { type: 'system'; conversationId: string; seq: number; payload: unknown }
  | {
      type: 'result';
      conversationId: string;
      seq: number;
      durationMs?: number;
      numTurns?: number;
      totalCostUsd?: number;
      isError?: boolean;
    }
  | { type: 'error'; conversationId: string; seq: number; message: string }
  | { type: 'stream_closed'; conversationId: string; seq: number };

// --- Client → Server POST messages ---

export type InputMessage =
  | { type: 'send'; text: string }
  | { type: 'permission_reply'; requestId: string; decision: 'allow' | 'deny'; updatedInput?: unknown }
  | { type: 'interrupt' };

// --- Agent-worker RPC protocol (over Unix socket, JSONL) ---

export type WorkerRpcRequest =
  | { id: string; op: 'ping' }
  | {
      id: string;
      op: 'start_or_resume';
      conversationId: string;
      cwd: string;
      provider: Provider;
      model: ModelId;
      permissionMode: PermissionMode;
      sdkSessionId: string | null;
      mcpServers: Record<string, McpServerConfig>;
      permissionTimeoutMs: number;
      authMode: AuthMode;
      anthropicApiKey: string;
      claudeCodeOauthToken: string;
      openaiApiKey: string;
    }
  | { id: string; op: 'send_user_message'; conversationId: string; text: string }
  | { id: string; op: 'set_permission_mode'; conversationId: string; mode: PermissionMode }
  | { id: string; op: 'set_model'; conversationId: string; model: ModelId }
  | {
      id: string;
      op: 'resolve_permission';
      conversationId: string;
      requestId: string;
      decision: 'allow' | 'deny';
      updatedInput?: unknown;
    }
  | { id: string; op: 'interrupt'; conversationId: string }
  | { id: string; op: 'close_session'; conversationId: string }
  | { id: string; op: 'list_slash_commands'; conversationId: string }
  | { id: string; op: 'subscribe'; conversationId: string }
  | { id: string; op: 'unsubscribe'; conversationId: string };

// Distributive Omit so TypeScript can narrow unions correctly when we strip
// the `id` field from a request before sending (agent-client adds it).
export type WorkerRpcRequestBody = WorkerRpcRequest extends infer T
  ? T extends { id: string }
    ? Omit<T, 'id'>
    : never
  : never;

export type WorkerRpcResponse =
  | { id: string; ok: true; result?: unknown }
  | { id: string; ok: false; error: string };

// Events pushed from worker → route handlers on subscribed sockets.
export type WorkerEvent = {
  kind: 'event';
  conversationId: string;
  frame: StreamFrame;
};
