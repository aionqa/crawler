import vm from 'vm';

export function codeWrap(statements) {
  return `async function __ai_exec__({ page, action, project, helpers }) {\n${statements}\n}\n__ai_exec__;`;
}

export async function safeEvalFunction(js, scope) {
  const script = new vm.Script(js, { timeout: 10_000, displayErrors: true });
  const ctx = vm.createContext({ ...scope });
  const exported = script.runInContext(ctx, { timeout: 10_000 });
  if (typeof exported !== 'function') throw new Error('AI code did not produce a function');
  return exported;
}
