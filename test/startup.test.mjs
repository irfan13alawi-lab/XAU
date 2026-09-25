import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('local build ID is deterministic across processes and ignores runtime overrides', { timeout: 15_000 }, async () => {
  const loadBuildId = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', "import { config } from './src/config.mjs'; process.stdout.write(config.buildId)",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, LIVE_TRADING_ENABLED: 'false', NEXORA_BUILD_ID: 'override-label-must-not-be-returned' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`build ID process failed (${code ?? signal}): ${stderr}`));
    });
  });
  const [first, second] = await Promise.all([loadBuildId(), loadBuildId()]);
  assert.match(first, /^LOCAL-[a-f0-9]{12}$/);
  assert.equal(second, first);
  assert.doesNotMatch(first, /override-label/);
});

test('successful bind initializes the database and then serves paper-only health', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexora-startup-ready-'));
  const databasePath = join(directory, 'nexora.sqlite');
  let child;
  try {
    child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LIVE_TRADING_ENABLED: 'false',
        NEXORA_HOST: '127.0.0.1',
        NEXORA_PORT: '0',
        NEXORA_DB_PATH: databasePath,
        PAPER_MODE: 'true',
        NEXORA_CONTROL_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const listening = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 10_000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        for (const line of stdout.split(/\r?\n/)) {
          try {
            const event = JSON.parse(line);
            if (event.event === 'server_listening') {
              clearTimeout(timer);
              resolve(event.url);
            }
          } catch {}
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`server exited before listen (${code ?? signal}): ${stdout}\n${stderr}`));
      });
    });
    const url = await listening;
    const { status, body, requestId } = await new Promise((resolve, reject) => {
      const request = http.get(`${url}/healthz?token=must-not-appear-in-logs`, { agent: false }, (response) => {
        let payload = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { payload += chunk; });
        response.on('end', () => resolve({
          status: response.statusCode,
          body: JSON.parse(payload),
          requestId: response.headers['x-request-id'],
        }));
      });
      request.once('error', reject);
    });
    assert.equal(status, 200);
    assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const requestLog = await new Promise((resolve, reject) => {
      const findRequestLog = () => {
        for (const line of stdout.split(/\r?\n/)) {
          try {
            const event = JSON.parse(line);
            if (event.event === 'http_request_completed' && event.requestId === requestId) return event;
          } catch {}
        }
        return null;
      };
      const timer = setTimeout(() => {
        child.stdout.off('data', onData);
        reject(new Error(`request log did not arrive for ${requestId}`));
      }, 5000);
      const onData = () => {
        const event = findRequestLog();
        if (!event) return;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(event);
      };
      child.stdout.on('data', onData);
      const event = findRequestLog();
      if (event) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(event);
      }
    });
    assert.equal(requestLog.route, 'health');
    assert.equal(requestLog.status, 200);
    assert.ok(Number.isFinite(requestLog.durationMs) && requestLog.durationMs >= 0);
    assert.doesNotMatch(JSON.stringify(requestLog), /must-not-appear-in-logs|token=/i);
    const health = body;
    assert.equal(health.liveness, 'ok');
    assert.equal(health.schemaVersion, 11);
    assert.equal(health.readiness, 'not_ready');
    assert.equal(health.controlActionsAvailable, true);
    assert.equal(health.controlAuthRequired, false);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    const [code] = await exited;
    assert.ok(code !== 0, `isolated startup process should be stopped after health check: ${stderr}`);
    child = null;
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('port conflict exits before opening or migrating the configured database', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexora-port-conflict-'));
  const databasePath = join(directory, 'must-not-be-created.sqlite');
  const occupiedPort = net.createServer();
  let child;
  try {
    await new Promise((resolve, reject) => {
      occupiedPort.once('error', reject);
      occupiedPort.listen(0, '127.0.0.1', resolve);
    });
    const port = occupiedPort.address().port;
    child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LIVE_TRADING_ENABLED: 'false',
        NEXORA_HOST: '127.0.0.1',
        NEXORA_PORT: String(port),
        NEXORA_DB_PATH: databasePath,
        PAPER_MODE: 'true',
        NEXORA_CONTROL_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const [code] = await once(child, 'exit');
    assert.equal(code, 1, `startup should fail safely; stdout=${stdout}; stderr=${stderr}`);
    assert.match(`${stdout}\n${stderr}`, /PORT_IN_USE/);
    await assert.rejects(access(databasePath), { code: 'ENOENT' });
    await assert.rejects(access(`${databasePath}-wal`), { code: 'ENOENT' });
    await assert.rejects(access(`${databasePath}-shm`), { code: 'ENOENT' });
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await new Promise((resolve) => occupiedPort.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('live execution cannot be enabled and startup exits before opening its database', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexora-live-disabled-'));
  const databasePath = join(directory, 'must-not-be-created.sqlite');
  let child;
  try {
    child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LIVE_TRADING_ENABLED: 'true',
        NEXORA_HOST: '127.0.0.1',
        NEXORA_PORT: '0',
        NEXORA_DB_PATH: databasePath,
        NEXORA_CONTROL_TOKEN: '',
        NEXORA_TELEGRAM_ENABLED: 'false',
        NEXORA_TELEGRAM_NOTIFICATIONS_ENABLED: 'false',
        NEXORA_TELEGRAM_BOT_TOKEN: '',
        NEXORA_TELEGRAM_ALLOWED_USER_IDS: '',
        NEXORA_TELEGRAM_ALLOWED_CHAT_IDS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(output, /Live trading is not implemented/);
    await assert.rejects(access(databasePath), { code: 'ENOENT' });
    await assert.rejects(access(`${databasePath}-wal`), { code: 'ENOENT' });
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
