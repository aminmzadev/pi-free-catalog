// Pure verification logic shared by the opt-in live runner and offline negative tests.
import { join, resolve } from 'node:path';

export function assessToolWorkflow({
  events,
  cwd,
  dir,
  data,
  expected,
  answer,
  last,
  sha,
  token,
  fixtureUnchanged,
  verifierUnchanged,
}) {
  const starts = events.filter((e) => e.type === 'tool_execution_start');
  const ends = events.filter((e) => e.type === 'tool_execution_end');
  const names = ['read', 'write', 'edit', 'bash'];
  const matches = (start, name) => {
    if (
      start.toolName !== name ||
      !ends.some((end) => end.toolCallId === start.toolCallId && !end.isError)
    )
      return false;
    if (name === 'bash')
      return (
        typeof start.args?.command === 'string' &&
        start.args.command.includes('verify.py') &&
        ends.some(
          (end) =>
            end.toolCallId === start.toolCallId &&
            JSON.stringify(end.result).includes(sha),
        )
      );
    return (
      typeof start.args?.path === 'string' &&
      resolve(cwd, start.args.path) ===
        join(dir, name === 'read' ? 'fixture.txt' : 'result.txt')
    );
  };
  const checks = Object.fromEntries(
    names.map((name) => [name, starts.some((start) => matches(start, name))]),
  );
  let next = 0;
  for (const start of starts)
    if (next < names.length && matches(start, names[next])) next++;
  const ordered = next === names.length;
  const stopReason = last?.stopReason;
  const pass =
    stopReason === 'stop' &&
    !last?.errorMessage &&
    Object.values(checks).every(Boolean) &&
    ordered &&
    data === expected &&
    answer.includes(token) &&
    answer.includes(sha) &&
    fixtureUnchanged &&
    verifierUnchanged;
  return {
    checks,
    ordered,
    stopReason,
    errorMessage: last?.errorMessage,
    pass,
  };
}

export function assertModelCompleted(last) {
  if (last?.stopReason === 'error' || last?.stopReason === 'aborted') {
    throw new Error(
      `Live model error; stopped without retries/fallback: ${last.errorMessage || last.stopReason}`,
    );
  }
}
