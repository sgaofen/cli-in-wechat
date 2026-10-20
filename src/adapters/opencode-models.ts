// Only filter recognized built-in text routes; custom providers and media stay visible.
function miniMaxTextModel(model: string): string | undefined {
  const id = model.toLowerCase();
  if (/^(?:minimax|minimax-cn|opencode|openrouter\/minimax)\/minimax-text-01$/.test(id)) return 'minimax-text-01';
  const match = /^(?:minimax|minimax-cn|minimax-coding-plan|minimax-cn-coding-plan|opencode)\/(minimax-m\d+(?:\.\d+)*(?:-(?:flash|highspeed|lightning|\d+k))?(?:-free)?)$/.exec(id)
    ?? /^openrouter\/minimax\/(minimax-m\d+(?:\.\d+)*(?:-(?:flash|highspeed|lightning|\d+k))?(?::free)?)$/.exec(id);
  return match?.[1];
}

export function ordinaryOpenCodeModels(models: string[]): string[] {
  const rank = (model: string) => {
    const id = miniMaxTextModel(model);
    if (id === undefined) return 2;
    if (['minimax-m3.1-flash', 'minimax-m3.1-flash-free', 'minimax-m3.1-flash:free'].includes(id)) return 0;
    if (id === 'minimax-m3') return 1;
    return -1;
  };
  // Do not invent routes that the installed CLI has not advertised.
  return models.filter((model) => rank(model) >= 0).sort((a, b) => rank(a) - rank(b));
}

export function flashEffortVariant(model: string, effort: string, verboseCatalog: string): string | undefined {
  const id = miniMaxTextModel(model);
  if (!id?.startsWith('minimax-m3.1-flash')) return undefined;
  const level = effort.trim().toLowerCase();
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(level)) return undefined;

  // `opencode models --verbose` prints a route followed by its pretty-printed JSON.
  // Variants belong to the installed CLI/provider, not to this bridge.
  const lines = verboseCatalog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === model);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^\S+\/\S+$/.test(line));
  try {
    const metadata = JSON.parse(lines.slice(start + 1, end < 0 ? undefined : end).join('\n'));
    return metadata.variants && Object.hasOwn(metadata.variants, level) ? level : undefined;
  } catch {
    return undefined;
  }
}

export function isMiniMaxFlash(model: string): boolean {
  return miniMaxTextModel(model)?.startsWith('minimax-m3.1-flash') ?? false;
}
