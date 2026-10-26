// A stand-in for the .NET runner, for the process client's tests. What it does depends on the
// request's url: "loop" never answers, "crash" exits, "garbage" answers with something not JSON,
// "bad" gets an error reply. Anything else gets a result naming the url.
import { createInterface } from 'node:readline';

createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  if (req.hello) return console.log(JSON.stringify({ id: req.id, version: 'fake' }));
  const url = req.run?.request?.url;
  if (url === 'loop') return;
  if (url === 'crash') {
    process.stderr.write('boom\n');
    process.exit(3);
  }
  if (url === 'garbage') return console.log('not json');
  if (url === 'bad') return console.log(JSON.stringify({ id: req.id, error: 'unreadable' }));
  console.log(JSON.stringify({ id: req.id, result: { variables: { url: { type: 'String', value: url } }, calls: [], trace: [], steps: [] } }));
});
