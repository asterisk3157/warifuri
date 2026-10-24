// A goal's flow as Mermaid flowchart text: its tasks as nodes, the order between them as
// arrows, and a colour for each task's standing. Pure functions: no I/O, no clock.
//
// Standing, first match wins: done; running (held by a device, or in state running);
// next (ready, and every task before it is closed: 次にやれる); waiting; other.

export const FLOW_TITLE_MAX = 40;

export const FLOW_CLASSES = {
  done: 'fill:#d3f9d8,stroke:#2f9e44,color:#1b4332',
  running: 'fill:#d0ebff,stroke:#1c7ed6,color:#0b3d75',
  next: 'fill:#fff3bf,stroke:#f08c00,color:#5c3c00',
  waiting: 'fill:#ffe3e3,stroke:#e03131,color:#6b1010',
  other: 'fill:#f1f3f5,stroke:#868e96,color:#343a40',
};

// The first `max` characters (code points), with an ellipsis when cut.
export function truncate(text, max = FLOW_TITLE_MAX) {
  const chars = [...String(text ?? '')];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

// Text safe inside a Mermaid ["..."] label: entity codes for the characters Mermaid reads
// as syntax, and line breaks folded to spaces.
export function escapeLabel(text) {
  return String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;');
}

// Which class a task gets. openBefore: how many of its predecessors are not closed.
export function standing(task, { held = false, openBefore = 0 } = {}) {
  if (task.state === 'done') return 'done';
  if (held || task.state === 'running') return 'running';
  if (task.state === 'ready' && openBefore === 0) return 'next';
  if (task.state === 'waiting') return 'waiting';
  return 'other';
}

// goal: { title }. tasks: [{ id, title, state }] in display order. edges: [{ before_id,
// after_id }] between those tasks. holds: Map(task id → device name). openBefore: Map(task id
// → number of open predecessors, counting tasks outside the goal too).
export function renderFlow(goal, tasks, edges, { holds = new Map(), openBefore = new Map() } = {}) {
  const lines = ['---', `title: ${JSON.stringify(String(goal.title ?? ''))}`, '---', 'flowchart TD'];
  const nodeId = new Map(tasks.map((t, i) => [t.id, `n${i}`]));
  const byClass = new Map(Object.keys(FLOW_CLASSES).map((c) => [c, []]));
  for (const t of tasks) {
    const device = holds.get(t.id);
    let label = escapeLabel(truncate(t.title));
    if (device) label += `<br/>${escapeLabel(device)} で作業中`;
    lines.push(`  ${nodeId.get(t.id)}["${label}"]`);
    byClass.get(standing(t, { held: !!device, openBefore: openBefore.get(t.id) ?? 0 })).push(nodeId.get(t.id));
  }
  for (const e of edges) {
    if (nodeId.has(e.before_id) && nodeId.has(e.after_id)) lines.push(`  ${nodeId.get(e.before_id)} --> ${nodeId.get(e.after_id)}`);
  }
  for (const [name, style] of Object.entries(FLOW_CLASSES)) lines.push(`  classDef ${name} ${style}`);
  for (const [name, ids] of byClass) if (ids.length) lines.push(`  class ${ids.join(',')} ${name}`);
  return `${lines.join('\n')}\n`;
}
