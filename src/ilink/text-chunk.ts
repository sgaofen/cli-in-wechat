/** Split text by UTF-8 bytes without splitting a Unicode code point. */
export function chunkUtf8Text(text: string, maxBytes: number): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('maxBytes must be positive');
  }
  if (text.length === 0) return [];

  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (current && currentBytes + codePointBytes > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }

    // A configured limit smaller than one code point cannot be satisfied without
    // corrupting text, so preserve the code point as a single oversized chunk.
    if (!current && codePointBytes > maxBytes) {
      chunks.push(codePoint);
      continue;
    }

    current += codePoint;
    currentBytes += codePointBytes;
  }

  if (current) chunks.push(current);
  return chunks;
}
