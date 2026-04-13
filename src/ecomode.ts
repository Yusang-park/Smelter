export type ModelTier = 'haiku' | 'sonnet' | 'opus';

const TIER_MAP: Record<ModelTier, string[]> = {
  haiku: ['claude-haiku-4-5', 'gpt-4o-mini', 'gemini-2.5-flash'],
  sonnet: ['claude-sonnet-4-6', 'gpt-4o', 'gemini-2.5-pro'],
  opus: ['claude-opus-4-5', 'o3', 'gemini-2.5-pro'],
};

export function downgradeModel(model: string): string {
  // Find current tier
  for (const [tier, models] of Object.entries(TIER_MAP)) {
    if (models.some((m) => model.includes(m) || m.includes(model))) {
      if (tier === 'opus') return TIER_MAP.sonnet[0];
      if (tier === 'sonnet') return TIER_MAP.haiku[0];
      return model; // already lowest
    }
  }
  return model; // unknown model, no change
}

export function getModelForTier(
  tier: ModelTier,
  provider: 'claude' | 'openai' | 'gemini' = 'claude',
): string {
  const idx = provider === 'claude' ? 0 : provider === 'openai' ? 1 : 2;
  return TIER_MAP[tier][idx];
}

export function detectTier(model: string): ModelTier {
  for (const [tier, models] of Object.entries(TIER_MAP) as [ModelTier, string[]][]) {
    if (models.some((m) => model.includes(m) || m.includes(model))) return tier;
  }
  return 'sonnet'; // default
}
