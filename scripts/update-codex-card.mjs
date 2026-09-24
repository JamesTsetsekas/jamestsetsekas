/**
 * Refresh from a machine signed in to Codex:
 *   node scripts/update-codex-card.mjs
 *
 * This reads aggregate usage through the local Codex app-server and updates
 * assets/codex-activity.svg. The Raspberry Pi cron job handles scheduling and
 * publishing; this script only updates the SVG.
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const cardUrl = new URL('../assets/codex-activity.svg', import.meta.url);

function readUsage() {
  return new Promise((resolve, reject) => {
    const processHandle = spawn('codex', ['app-server'], {
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = createInterface({ input: processHandle.stdout });
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Codex usage request timed out.')), 30_000);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      processHandle.kill();
      if (error) reject(error);
      else resolve(result);
    }

    function send(message) {
      processHandle.stdin.write(`${JSON.stringify(message)}\n`);
    }

    processHandle.on('error', () => finish(new Error('Could not start the Codex CLI.')));
    processHandle.on('exit', () => finish(new Error('Codex app-server exited before returning usage.')));
    processHandle.stdin.on('error', () => finish(new Error('Could not send a request to Codex app-server.')));
    lines.on('line', line => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) return finish(new Error('Codex app-server initialization failed.'));
        send({ method: 'initialized' });
        send({ method: 'account/usage/read', id: 2 });
      }
      if (message.id === 2) {
        if (message.error) return finish(new Error('Codex usage is unavailable for this sign-in.'));
        finish(null, message.result?.summary);
      }
    });
    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'github_profile_card',
          title: 'GitHub Profile Card',
          version: '1.0.0',
        },
      },
    });
  });
}

function requireCount(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Codex did not return a valid ${name} value; card unchanged.`);
  }
  return value;
}

function compact(value) {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function replaceText(svg, id, value) {
  const expression = new RegExp(`(<text id="${id}"[^>]*>)[^<]*(</text>)`);
  if (!expression.test(svg)) throw new Error(`Card is missing the ${id} field; card unchanged.`);
  return svg.replace(expression, (_match, start, end) => `${start}${value}${end}`);
}

function updateDescription(svg, date) {
  return svg.replace(
    /(<desc id="description">)[^<]*(<\/desc>)/,
    `$1Lifetime tokens, current streak, and peak daily tokens. Refreshed ${date}.$2`,
  );
}

async function main() {
  const summary = await readUsage();
  const lifetime = requireCount(summary?.lifetimeTokens, 'lifetime tokens');
  const streak = requireCount(summary?.currentStreakDays, 'current streak');
  const peak = requireCount(summary?.peakDailyTokens, 'peak daily tokens');
  const now = new Date();
  const dateLabel = now.toLocaleDateString('en-US', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).toUpperCase();
  const isoDate = now.toISOString().slice(0, 10);

  let svg = await readFile(cardUrl, 'utf8');
  svg = replaceText(svg, 'lifetime-count', compact(lifetime));
  svg = replaceText(svg, 'streak-count', String(streak));
  svg = replaceText(svg, 'peak-count', compact(peak));
  svg = replaceText(svg, 'updated-at', `REFRESHED · ${dateLabel}`);
  svg = replaceText(svg, 'refresh-state', 'DAILY SYNC');
  svg = updateDescription(svg, isoDate);
  await writeFile(cardUrl, svg, 'utf8');
  console.log(`Updated ${fileURLToPath(cardUrl)}. Review and commit it when ready.`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
