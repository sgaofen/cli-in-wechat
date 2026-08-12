const sessionID = 'ses_fixture';

export const OPEN_CODE_EVENTS = [
  {
    type: 'step_start',
    sessionID,
    part: { type: 'step-start' },
  },
  {
    type: 'reasoning',
    sessionID,
    part: { type: 'reasoning', text: '先检查目录。' },
  },
  {
    type: 'tool_use',
    sessionID,
    part: {
      type: 'tool',
      callID: 'call_shell_ok',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'npm   test' },
        output: 'Exit code 0\nall tests passed',
      },
    },
  },
  {
    type: 'text',
    sessionID,
    part: { type: 'text', text: '检查完成。' },
  },
  {
    type: 'step_finish',
    sessionID,
    part: { type: 'step-finish', reason: 'stop' },
  },
] as const;

export const OPEN_CODE_JSONL = OPEN_CODE_EVENTS.map((event) => JSON.stringify(event)).join('\n');

export const OPEN_CODE_ERROR_JSONL = [
  {
    type: 'tool_use',
    sessionID,
    part: {
      type: 'tool',
      callID: 'call_shell_error',
      tool: 'bash',
      state: {
        status: 'error',
        input: { command: 'exit 2' },
        error: 'Exit code 2\nPermission denied',
      },
    },
  },
  {
    type: 'tool_use',
    sessionID,
    part: {
      type: 'tool',
      callID: 'call_custom_error',
      tool: 'custom-tool',
      state: {
        status: 'error',
        input: { target: 'fixture' },
        error: 'Unrecognized private failure detail',
      },
    },
  },
  {
    type: 'step_finish',
    sessionID,
    part: { type: 'step-finish', reason: 'error' },
  },
].map((event) => JSON.stringify(event)).join('\n');
