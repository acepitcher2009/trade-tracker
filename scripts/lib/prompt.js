import readline from 'node:readline/promises';

export async function ask(question, def) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(def ? `${question} [${def}]: ` : `${question}: `)).trim();
  rl.close();
  return a || def || '';
}

/** Read a PIN without echoing it. Falls back to env var `envName` when not a TTY. */
export function askSecret(question, envName) {
  if (!process.stdin.isTTY) {
    const v = envName && process.env[envName];
    if (!v) throw new Error(`No terminal available: set ${envName} in the environment instead.`);
    return Promise.resolve(v);
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
          process.stdout.write('\n'); return resolve(buf);
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1); else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}
