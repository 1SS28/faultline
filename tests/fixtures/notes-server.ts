// a tiny mcp server for the proxy tests: one write that repeats on a retry, one that doesn't, and a read
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export function notesServer() {
  const notes: Array<{ id: string; title: string }> = [];
  const byKey = new Map<string, string>();
  const server = new Server({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: 'Keeps short notes.' });
  const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] });
  const title = { type: 'string', description: 'What the note says' };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'create_note', description: 'Create a note.', inputSchema: { type: 'object' as const, properties: { title }, required: ['title'] } },
    { name: 'create_note_once', description: 'Create a note. Calls with the same key create it once.',
      inputSchema: { type: 'object' as const, properties: { title, key: { type: 'string' } }, required: ['title', 'key'] } },
    { name: 'list_notes', description: 'List every note.', inputSchema: { type: 'object' as const, properties: {} } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params;
    if (name === 'list_notes') return text(notes);
    if (name !== 'create_note' && name !== 'create_note_once') throw new Error(`Unknown tool: ${name}`);
    if (typeof args.title !== 'string' || !args.title) return { ...text('A note needs a title'), isError: true };
    const key = name === 'create_note_once' ? String(args.key ?? '') : '';
    const earlier = notes.find(note => key && note.id === byKey.get(key));
    if (earlier) return text(earlier);
    const note = { id: `note_${notes.length + 1}`, title: args.title };
    notes.push(note);
    if (key) byKey.set(key, note.id);
    return text(note);
  });
  return { server, notes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await notesServer().server.connect(new StdioServerTransport());
}
