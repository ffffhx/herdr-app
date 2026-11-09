// Isolated UI fixture: no credentials, network model calls, or workspace actions.
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const log = process.argv[2];
let nextChild = 0;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const part of req) chunks.push(part);
  let data;
  try { data = JSON.parse(Buffer.concat(chunks)); } catch { data = {}; }
  const input = data.input ?? [];
  const user = input.filter(item => item.role === 'user').at(-1);
  const prompt = typeof user?.content === 'string' ? user.content
    : (user?.content ?? []).map(part => part.text ?? '').join('\n');
  const tools = (data.tools ?? []).flatMap(tool => tool.type === 'namespace'
    ? (tool.tools ?? []).map(fn => `${tool.name}.${fn.name}`) : [tool.name]);
  const spawn = tools.find(name => /(^|\.)spawn_agent$/.test(name));
  // V2 can deliver its initial task outside the last user message.
  const child = /CHILD FIXTURE ([AB])/.exec(prompt)?.[1]
    ?? (!spawn ? /CHILD FIXTURE ([AB])/.exec(JSON.stringify(data))?.[1] : undefined)
    // The local SSE fixture does not implement V2's out-of-band task injection.
    // Its two fresh child contexts still get distinct, deterministic streams.
    ?? (!spawn && prompt.startsWith('<environment_context>')
      ? ['A', 'B'][nextChild++ % 2] : undefined);
  const results = input.slice(input.lastIndexOf(user) + 1).filter(item => item.type === 'function_call_output');
  const shouldSpawn = prompt.includes('CREATE TWO CHILDREN') && spawn
    && !results.length;
  if (log) appendFileSync(log, JSON.stringify({ path: req.url, prompt, tools, child, shouldSpawn }) + '\n');
  const stamp = Date.now();
  const id = `resp_${stamp}`;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } });
  const output = [];
  if (shouldSpawn) {
    // Leave time to type a draft before the native child-start notifications arrive.
    await delay(2500);
    for (const [index, name] of ['A', 'B'].entries()) {
      const item = { type: 'function_call', id: `fc_${stamp}_${index}`, call_id: `call_${stamp}_${index}`,
        name: spawn.split('.').at(-1), namespace: spawn.includes('.') ? spawn.slice(0, spawn.lastIndexOf('.')) : undefined,
        arguments: JSON.stringify({ message: `CHILD FIXTURE ${name}: report progress only`,
          ...(spawn.startsWith('multi_agent_v1.') ? { agent_type: 'default' }
            : { task_name: `fixture_${name.toLowerCase()}`, fork_turns: 'none' }) }), status: 'completed' };
      send({ type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '', status: 'in_progress' } });
      send({ type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: item.arguments });
      send({ type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, arguments: item.arguments });
      send({ type: 'response.output_item.done', output_index: index, item });
      output.push(item);
    }
  } else {
    const text = child ? `SUBAGENT ${child}: independent child task.\n` + Array.from({ length: 18 }, (_, i) => `Progress ${i + 1}: observing the isolated fixture.\n`).join('')
      : prompt.includes('FORK FIXTURE') ? 'FORK SESSION: New session, with the original conversation still visible on the left.'
      : prompt.includes('CREATE TWO CHILDREN') ? 'MAIN SESSION: Two child tasks are running. The main input stays available.'
      : prompt.includes('SIDE FIXTURE') || /Side conversation boundary/.test(JSON.stringify(input)) ? 'SIDE SESSION: Native side-chat behavior is preserved.'
      : 'MAIN SESSION: Original conversation. Keep this visible while opening a fork or child agents.';
    const item = { id: `msg_${stamp}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    send({ type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    for (const line of text.split(/(?<=\n)/)) {
      if (child) await delay(800);
      send({ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: line });
    }
    send({ type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text });
    send({ type: 'response.output_item.done', output_index: 0, item });
    output.push(item);
  }
  send({ type: 'response.completed', response: { id, object: 'response', status: 'completed', output,
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, input_tokens_details: { cached_tokens: 0 } } } });
  res.end();
});
server.listen(Number(process.argv[3] ?? 0), '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
