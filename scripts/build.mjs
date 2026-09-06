import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The build, with the agent origin remembered.
 *
 * WHY THIS EXISTS. `AGENT_ORIGIN` is a build-time input: set, it bakes the
 * server origin into the bundle and declares a `host_permissions` entry for that
 * one host; unset, it produces the default build with neither.
 *
 * Both are legitimate, and they write to the SAME `.output/` directory - which
 * is also the directory a developer has loaded unpacked in their browser. So a
 * plain `npm run build` silently replaced a configured build with a default one,
 * and `npm run test:built` did it as a side effect of running tests.
 *
 * That is not a cosmetic problem. On the next extension reload, rehydration in
 * `background.ts` finds the stored cloud origin, asks the browser whether it has
 * permission to reach it, gets NO because the manifest no longer declares it,
 * and DEMOTES the selection to on-device. The demotion is deliberate and it is
 * announced - it is the safe direction - but the cause is a test command, and
 * the symptom is a run that plans on-device while the user believes it is
 * talking to their server. It cost a real debugging session.
 *
 * Two fixes, both here:
 *
 *   1. The origin is read from `.env` when the environment does not supply it,
 *      so it survives a shell, a reboot and a different terminal. One-time
 *      setup instead of a variable that must be retyped correctly every time.
 *   2. `--no-origin` builds the default deliberately, for the tests that assert
 *      it - and `test:built` restores the configured build afterwards, so the
 *      loaded extension is never left in a state nobody chose.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Reads one key out of `.env`.
 *
 * Hand-parsed rather than pulling in a dependency: this needs one key, the
 * format is `KEY=value`, and a dotenv library would be more code than the
 * parser. Quotes are stripped because people type them; everything after the
 * first `=` is the value, because a URL may not contain one but a token can.
 */
function fromEnvFile(key) {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return '';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at < 0) continue;
    if (trimmed.slice(0, at).trim() !== key) continue;
    return trimmed
      .slice(at + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
  }
  return '';
}

const noOrigin = process.argv.includes('--no-origin');

/*
 * The environment WINS over the file. A variable set for one command is a
 * deliberate override for that command, and a file that could silently beat it
 * would make the override untestable.
 */
const origin = noOrigin ? '' : (process.env.AGENT_ORIGIN ?? '') || fromEnvFile('AGENT_ORIGIN');

const targets = [
  ['chrome', ['build', '-b', 'chrome']],
  ['firefox', ['build', '-b', 'firefox', '--mv3']],
];

console.log(
  origin === ''
    ? `[build] AGENT_ORIGIN not set - DEFAULT build: nothing configured, on-device by default${
        noOrigin ? ' (--no-origin)' : ''
      }`
    : `[build] AGENT_ORIGIN=${origin} - baking the origin and one host permission`,
);

for (const [name, args] of targets) {
  const result = spawnSync('npx', ['wxt', ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    env: origin === '' ? { ...process.env, AGENT_ORIGIN: '' } : { ...process.env, AGENT_ORIGIN: origin },
  });
  if (result.status !== 0) {
    console.error(`[build] ${name} build failed`);
    process.exit(result.status ?? 1);
  }
}

if (origin === '' && !noOrigin) {
  /*
   * Said out loud, because this is the state that reads as a broken extension.
   * A default build loaded over a configured one demotes the stored backend to
   * on-device on the next reload, and the run that follows plans locally while
   * looking like it did not.
   */
  console.log(
    '[build] NOTE: this build has no baked server. If you had loaded a cloud build,\n' +
      '        reloading this one will demote the stored backend to on-device.\n' +
      '        Set it once:  echo AGENT_ORIGIN=https://your-service.onrender.com > .env',
  );
}
