import type { WorkflowDef } from '@co/protocol';

export interface KernelRunContext {
  vars: Record<string, string>;
  outputs: Record<string, string>;
}

type LocalValues = Record<string, unknown>;

function parseStructured(value: string): unknown {
  const trimmed = value.trim();
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  // Agent 常先解释、最后输出 JSON；只接受能完整解析到文本尾部的对象/数组后缀。
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '{' || trimmed[i] === '[') candidates.push(trimmed.slice(i));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 尝试下一个候选；绝不 eval 模型输出。
    }
  }
  return value;
}

function property(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function fromRecord(record: Record<string, unknown>, path: string): unknown {
  const keys = Object.keys(record).sort((a, b) => b.length - a.length);
  const key = keys.find((candidate) => path === candidate || path.startsWith(`${candidate}.`));
  if (!key) return undefined;
  const tail = path === key ? [] : path.slice(key.length + 1).split('.');
  const raw = record[key];
  return property(typeof raw === 'string' ? parseStructured(raw) : raw, tail);
}

/**
 * 统一解析模板、condition 与 fanout 的上下文路径。
 * `split.items` 会优先解析为 outputs.split 的 JSON.items，避免节点 id 含点号时误切分。
 */
export function resolveContextValue(
  rawPath: string,
  context: KernelRunContext,
  locals: LocalValues = {},
): unknown {
  const path = rawPath.trim().replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '');
  if (path.startsWith('vars.')) return fromRecord(context.vars, path.slice('vars.'.length));
  if (path.startsWith('outputs.')) return fromRecord(context.outputs, path.slice('outputs.'.length));

  const local = fromRecord(locals, path);
  if (local !== undefined) return local;
  const output = fromRecord(context.outputs, path);
  if (output !== undefined) return output;
  return fromRecord(context.vars, path);
}

function templateText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function substituteTemplate(
  template: string,
  context: KernelRunContext,
  locals: LocalValues = {},
): string {
  return template.replace(/\{\{\s*([\w.[\]-]+)\s*\}\}/g, (_, path: string) =>
    templateText(resolveContextValue(path, context, locals)),
  );
}

function topLevelOperator(expr: string, operators: string[]): { index: number; operator: string } | null {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const char = expr[i]!;
    if (quote) {
      if (char === quote && expr[i - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth++;
      continue;
    }
    if (char === ')') {
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    const operator = operators.find((candidate) => expr.startsWith(candidate, i));
    if (operator) return { index: i, operator };
  }
  return null;
}

function unwrap(expr: string): string {
  let result = expr.trim();
  while (result.startsWith('(') && result.endsWith(')')) {
    let depth = 0;
    let wrapsAll = true;
    for (let i = 0; i < result.length; i++) {
      if (result[i] === '(') depth++;
      if (result[i] === ')') depth--;
      if (depth === 0 && i < result.length - 1) {
        wrapsAll = false;
        break;
      }
    }
    if (!wrapsAll) break;
    result = result.slice(1, -1).trim();
  }
  return result;
}

function operand(expr: string, context: KernelRunContext): unknown {
  const value = unwrap(expr);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value === 'undefined') return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const resolved = resolveContextValue(value, context);
  if (resolved === undefined) throw new Error(`condition references unknown value: ${value}`);
  return resolved;
}

function truthy(value: unknown): boolean {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['', 'false', '0', 'null', 'undefined', 'no', 'off'].includes(normalized)) return false;
  }
  return Boolean(value);
}

function evaluate(expr: string, context: KernelRunContext): boolean {
  const value = unwrap(expr);
  const or = topLevelOperator(value, ['||']);
  if (or) return evaluate(value.slice(0, or.index), context) || evaluate(value.slice(or.index + 2), context);
  const and = topLevelOperator(value, ['&&']);
  if (and) return evaluate(value.slice(0, and.index), context) && evaluate(value.slice(and.index + 2), context);
  if (value.startsWith('!') && !value.startsWith('!=')) return !evaluate(value.slice(1), context);

  const comparison = topLevelOperator(value, ['===', '!==', '>=', '<=', '==', '!=', '>', '<']);
  if (!comparison) return truthy(operand(value, context));
  const left = operand(value.slice(0, comparison.index), context);
  const right = operand(value.slice(comparison.index + comparison.operator.length), context);
  switch (comparison.operator) {
    case '===': return left === right;
    case '==': return left == null && right == null ? true : String(left) === String(right);
    case '!==': return left !== right;
    case '!=': return left == null && right == null ? false : String(left) !== String(right);
    case '>': return Number(left) > Number(right);
    case '>=': return Number(left) >= Number(right);
    case '<': return Number(left) < Number(right);
    case '<=': return Number(left) <= Number(right);
    default: return false;
  }
}

export function evaluateConditionExpression(expr: string, context: KernelRunContext): boolean {
  if (!expr.trim()) throw new Error('condition expression is empty');
  return evaluate(expr, context);
}

function descendants(def: WorkflowDef, roots: string[]): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const [from, to] of def.edges) outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
  const found = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (found.has(id)) continue;
    found.add(id);
    queue.push(...(outgoing.get(id) ?? []));
  }
  return found;
}

/** 只跳过未选分支独占节点；两边都可达的汇合节点保留。 */
export function skippedBranchNodeIds(
  def: WorkflowDef,
  selectedRoots: string[],
  rejectedRoots: string[],
): string[] {
  const selected = descendants(def, selectedRoots);
  return [...descendants(def, rejectedRoots)].filter((id) => !selected.has(id));
}

export function resolveFanoutItems(
  itemsFrom: string,
  context: KernelRunContext,
  maxItems: number,
): unknown[] {
  const value = resolveContextValue(itemsFrom, context);
  if (!Array.isArray(value)) {
    throw new Error(`fanout itemsFrom must resolve to an array: ${itemsFrom}`);
  }
  if (value.length > maxItems) {
    throw new Error(`fanout resolved ${value.length} items, exceeding maxItems=${maxItems}`);
  }
  return value;
}
