// =============================================================================
// Codex adapter — direct API calls for `smelter run`
// Used when the active model is a Codex/OpenAI model.
// =============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Model names that should route to the OpenAI API instead of Anthropic. */
export const CODEX_MODEL_PREFIXES = ['gpt-', 'o3', 'o4', 'codex'];

export function isCodexModel(model: string | undefined): boolean {
  if (!model) return false;
  return CODEX_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

interface CodexAuth {
  token: string;
  accountId: string | null;
}

/**
 * Run a prompt via the ChatGPT Codex Responses API and return the full text.
 * Requires Codex CLI OAuth login in ~/.codex/auth.json.
 */
export async function runCodex(
  prompt: string,
  _cwd: string,
  model?: string,
): Promise<string> {
  const auth = getCodexAuth();
  if (!auth) {
    throw new Error('Codex OAuth is not set — run `codex login` first');
  }

  const baseUrl = (process.env.CHATGPT_API_BASE ?? 'https://chatgpt.com/backend-api/codex').replace(/\/$/, '');
  const selectedModel = model ?? 'gpt-5.4';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth.token}`,
  };
  if (auth.accountId) headers['ChatGPT-Account-ID'] = auth.accountId;

  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: selectedModel,
      input: [{ role: 'user', content: prompt }],
      store: false,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Codex API error ${response.status}: ${err}`);
  }

  const data = await response.json() as {
    output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
  };
  return data.output
    ?.filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text ?? '')
    .join('') ?? '';
}

function getCodexAuth(): CodexAuth | null {
  const authPath = join(homedir(), '.codex', 'auth.json');
  try {
    if (!existsSync(authPath)) return null;
    const auth = JSON.parse(readFileSync(authPath, 'utf8'));
    const token = auth.tokens?.access_token;
    if (!token) return null;
    return {
      token,
      accountId: auth.tokens?.account_id ?? null,
    };
  } catch {
    return null;
  }
}
