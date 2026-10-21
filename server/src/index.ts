import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadPuzzles } from './content.js';
import { createOpenAiCompatibleAdapterFromEnv } from './ai/openai-compatible.js';
import { WEB_DIST_DIRECTORY } from './paths.js';

const puzzles = await loadPuzzles();
const ai = createOpenAiCompatibleAdapterFromEnv();
const app = createApp({ puzzles, ai, staticWebDir: WEB_DIST_DIRECTORY });
const host = process.env.HOST?.trim() || '0.0.0.0';
const port = Number(process.env.PORT || 8787);
const server = createServer(app);

const cleanup = setInterval(() => app.locals.sweepExpired(), 60_000);
cleanup.unref();

server.listen(port, host, () => {
  process.stdout.write(`AI Turtle Soup API listening on http://${host}:${port}\n`);
});

function stop(): void {
  clearInterval(cleanup);
  server.close(() => process.exit(0));
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
