export interface ResponseMeta {
  tool?: string;
  duration?: number;
  error?: boolean;
}

export function formatResponse(text: string, meta?: ResponseMeta): string {
  const parts: string[] = [];
  if (meta?.error) parts.push('[错误]');
  parts.push(text);

  const footer: string[] = [];
  if (meta?.tool) footer.push(meta.tool);
  if (meta?.duration) {
    const sec = meta.duration / 1000;
    footer.push(sec >= 60 ? `${(sec / 60).toFixed(1)}min` : `${sec.toFixed(1)}s`);
  }
  if (footer.length > 0) parts.push(`\n— ${footer.join(' | ')}`);

  return parts.join('\n');
}
