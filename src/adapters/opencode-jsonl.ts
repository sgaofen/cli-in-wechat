import type { IntermediateMessage } from './base.js';
import { summarizeToolResult, summarizeToolUse } from './base.js';

export interface ParsedOpenCodeJsonl {
  text: string;
  thinking: string;
  sessionId?: string;
  hasError: boolean;
}

type IntermediateSink = (message: IntermediateMessage) => void;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}

export function parseOpenCodeJsonl(
  stdout: string,
  onIntermediate?: IntermediateSink,
): ParsedOpenCodeJsonl {
  let text = '';
  let thinking = '';
  let sessionId: string | undefined;
  let hasError = false;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue;
    }

    const type = nonEmptyString(event.type);
    const part = record(event.part);
    const partText = typeof part.text === 'string' ? part.text : '';

    if (!sessionId) {
      sessionId = nonEmptyString(event.sessionID) || undefined;
    }

    if (type === 'text' && partText) {
      text += partText;
      if (partText.trim()) {
        onIntermediate?.({ type: 'text', content: partText });
      }
    } else if (type === 'reasoning' && partText) {
      thinking += partText;
      if (partText.trim()) {
        onIntermediate?.({ type: 'thinking', content: partText });
      }
    } else if (type === 'tool_use') {
      const toolName = nonEmptyString(part.tool) || 'Tool';
      const state = record(part.state);
      onIntermediate?.({
        type: 'tool_use',
        content: summarizeToolUse(toolName, state.input),
        toolName,
      });

      const error = nonEmptyString(state.error);
      const output = state.output;
      const summary = error
        ? summarizeToolResult(toolName, error) || '  ↳ Error'
        : summarizeToolResult(toolName, output);
      if (summary) {
        onIntermediate?.({ type: 'tool_result', content: summary, toolName });
      }
    }

    if (type === 'step_finish' && part.reason === 'error') {
      hasError = true;
    }
  }

  return { text, thinking, sessionId, hasError };
}
