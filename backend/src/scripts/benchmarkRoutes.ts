/** Synthetic, read-only route probe. Use only seeded non-production accounts. */
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const required = (name: string) => {
  const value = option(name);
  if (!args.includes(name) || !value || value.startsWith('--')) throw new Error(`Missing ${name}`);
  return value;
};

async function main() {
  const base = required('--base-url').replace(/\/$/, '');
  const token = required('--bearer-token');
  const concurrency = Number(required('--concurrency'));
  const duration = Number(required('--duration-seconds'));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100 ||
      !Number.isFinite(duration) || duration < 1 || duration > 600) throw new Error('Invalid concurrency or duration');
  const paths = [
    '/api/health', '/api/student/courses', '/api/chat/sessions',
    // Supply a synthetic session ID through --message-session-id to include message reads.
    ...(args.includes('--message-session-id') ? [`/api/chat/sessions/${required('--message-session-id')}/messages`] : []),
  ];
  const deadline = Date.now() + duration * 1000;
  const timings = new Map<string, number[]>(paths.map(path => [path, []]));
  const errors = new Map<string, number>(paths.map(path => [path, 0]));
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    let index = worker;
    while (Date.now() < deadline) {
      const path = paths[index++ % paths.length];
      const started = performance.now();
      try {
        const response = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
        await response.arrayBuffer();
        timings.get(path)!.push(performance.now() - started);
        if (!response.ok) errors.set(path, errors.get(path)! + 1);
      } catch { errors.set(path, errors.get(path)! + 1); }
    }
  }));
  for (const path of paths) {
    const values = timings.get(path)!.sort((a, b) => a - b);
    const percentile = (p: number) => values[Math.min(values.length - 1, Math.floor(values.length * p))]?.toFixed(1) ?? 'n/a';
    process.stdout.write(`${path}: requests=${values.length} errors=${errors.get(path)} p50=${percentile(.5)}ms p95=${percentile(.95)}ms\n`);
  }
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Benchmark failed'}\n`); process.exitCode = 1; });
