#!/usr/bin/env node
/**
 * Reports the command line it was started with as the review's own answer, so a test can see the
 * arguments that actually reached the CLI through the supervisor rather than only the ones
 * `reviewArguments()` builds. No model runs and nothing is read from the working directory.
 */
let input = '';
for await (const chunk of process.stdin) input += chunk;
const emit = (value) => console.log(JSON.stringify(value));
emit({ type: 'thread.started', thread_id: 'fixture-argv-session' });
emit({ type: 'turn.started' });
emit({
  type: 'item.completed',
  item: { id: 'argv', type: 'agent_message', text: JSON.stringify(process.argv.slice(2)) },
});
emit({ type: 'turn.completed' });
