import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  WebSocketServerTransport,
  type BrowserCommandRequest,
} from './websocket.js';

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for test condition');
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('WebSocketServerTransport browser commands', () => {
  let transport: WebSocketServerTransport;
  let client: WebSocket;
  let requests: BrowserCommandRequest[];

  beforeEach(async () => {
    transport = new WebSocketServerTransport({
      port: 0,
      host: '127.0.0.1',
      authToken: 'test-token',
    });
    await transport.start();

    requests = [];
    client = new WebSocket(`ws://127.0.0.1:${transport.port}/?token=test-token`);
    client.on('message', data => {
      const message = JSON.parse(data.toString()) as { type?: string };
      if (message.type === 'command_request') {
        requests.push(message as BrowserCommandRequest);
      }
    });
    await once(client, 'open');
  });

  afterEach(async () => {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close();
      await once(client, 'close');
    }
    await transport.close();
  });

  it('correlates results and ignores an unrelated requestId', async () => {
    let settled = false;
    const resultPromise = transport
      .requestBrowserCommand({ type: 'set_frame_rate', fps: 24 }, 500)
      .finally(() => {
        settled = true;
      });

    await waitFor(() => requests.length === 1);
    client.send(JSON.stringify({
      type: 'command_result',
      requestId: 'unrelated-request',
      success: true,
    }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    client.send(JSON.stringify({
      type: 'command_result',
      requestId: requests[0].requestId,
      success: true,
      applied: { frameRate: 24 },
    }));

    await expect(resultPromise).resolves.toMatchObject({
      requestId: requests[0].requestId,
      applied: { frameRate: 24 },
    });
  });

  it('dispatches commands one at a time in FIFO order', async () => {
    const first = transport.requestBrowserCommand({ type: 'first' }, 500);
    const second = transport.requestBrowserCommand({ type: 'second' }, 500);

    await waitFor(() => requests.length === 1);
    expect(requests[0].command.type).toBe('first');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(requests).toHaveLength(1);

    client.send(JSON.stringify({
      type: 'command_result',
      requestId: requests[0].requestId,
      success: true,
    }));
    await expect(first).resolves.toMatchObject({ success: true });

    await waitFor(() => requests.length === 2);
    expect(requests[1].command.type).toBe('second');
    client.send(JSON.stringify({
      type: 'command_result',
      requestId: requests[1].requestId,
      success: true,
    }));
    await expect(second).resolves.toMatchObject({ success: true });
  });

  it('holds the FIFO slot until post-acknowledgement reconciliation completes', async () => {
    let finishReconciliation: (() => void) | undefined;
    const reconciliation = new Promise<void>(resolve => {
      finishReconciliation = resolve;
    });
    let firstSettled = false;
    const first = transport.requestBrowserCommand(
      { type: 'load_project' },
      500,
      async () => reconciliation,
    ).finally(() => {
      firstSettled = true;
    });
    const second = transport.requestBrowserCommand({ type: 'after_load' }, 500);

    await waitFor(() => requests.length === 1);
    client.send(JSON.stringify({
      type: 'command_result',
      requestId: requests[0].requestId,
      success: true,
    }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(firstSettled).toBe(false);
    expect(requests).toHaveLength(1);

    finishReconciliation!();
    await expect(first).resolves.toMatchObject({ success: true });
    await waitFor(() => requests.length === 2);
    expect(requests[1].command.type).toBe('after_load');

    client.send(JSON.stringify({
      type: 'command_result',
      requestId: requests[1].requestId,
      success: true,
    }));
    await expect(second).resolves.toMatchObject({ success: true });
  });

  it('prepares a queued command after prior reconciliation completes', async () => {
    let reconciledFrameIndex = 0;
    const navigation = transport.requestBrowserCommand(
      { type: 'go_to_frame', index: 1 },
      500,
      () => {
        reconciledFrameIndex = 1;
      },
    );
    const prepared = transport.requestBrowserCommand(
      { type: 'prepared_mutation' },
      500,
      undefined,
      () => ({
        type: 'prepared_mutation',
        observedFrameIndex: reconciledFrameIndex,
      }),
    );

    await waitFor(() => requests.length === 1);
    client.send(JSON.stringify({
      type: 'command_result',
      requestId: requests[0].requestId,
      success: true,
      applied: { currentFrameIndex: 1 },
    }));
    await expect(navigation).resolves.toMatchObject({ success: true });

    await waitFor(() => requests.length === 2);
    expect(requests[1].command).toEqual({
      type: 'prepared_mutation',
      observedFrameIndex: 1,
    });
    client.send(JSON.stringify({
      type: 'command_result',
      requestId: requests[1].requestId,
      success: true,
    }));
    await expect(prepared).resolves.toMatchObject({ success: true });
  });

  it('quarantines the channel when post-acknowledgement reconciliation fails', async () => {
    const first = transport.requestBrowserCommand(
      { type: 'load_project' },
      500,
      () => {
        throw new Error('State reconciliation failed');
      },
    );
    const queued = transport.requestBrowserCommand({ type: 'must_not_run' }, 500);
    const queuedExpectation = expect(queued).rejects.toThrow('State reconciliation failed');

    await waitFor(() => requests.length === 1);
    client.send(JSON.stringify({
      type: 'command_result',
      requestId: requests[0].requestId,
      success: true,
    }));

    await expect(first).rejects.toThrow('State reconciliation failed');
    await queuedExpectation;
    expect(requests).toHaveLength(1);
    await expect(
      transport.requestBrowserCommand({ type: 'blocked_until_reconnect' }),
    ).rejects.toThrow('requires reconnect and state reconciliation');
  });

  it('quarantines the channel and rejects the queue after an acknowledgement timeout', async () => {
    const result = transport.requestBrowserCommand({ type: 'slow_command' }, 20);
    const queued = transport.requestBrowserCommand({ type: 'must_not_run' }, 500);
    const queuedExpectation = expect(queued).rejects.toThrow(
      'Browser command "slow_command" timed out after 20ms',
    );
    await waitFor(() => requests.length === 1);
    await expect(result).rejects.toThrow(
      'Browser command "slow_command" timed out after 20ms',
    );
    await queuedExpectation;
    expect(requests).toHaveLength(1);
    await expect(
      transport.requestBrowserCommand({ type: 'blocked_until_reconnect' }),
    ).rejects.toThrow('requires reconnect and state reconciliation');
  });

  it('times out stalled command preparation and rejects the queue', async () => {
    const result = transport.requestBrowserCommand(
      { type: 'stalled_preparation' },
      20,
      undefined,
      () => new Promise(() => {}),
    );
    const queued = transport.requestBrowserCommand({ type: 'must_not_run' }, 500);
    const queuedExpectation = expect(queued).rejects.toThrow(
      'Browser command "stalled_preparation" timed out after 20ms',
    );

    await expect(result).rejects.toThrow(
      'Browser command "stalled_preparation" timed out after 20ms',
    );
    await queuedExpectation;
    expect(requests).toHaveLength(0);
    await expect(
      transport.requestBrowserCommand({ type: 'blocked_until_reconnect' }),
    ).rejects.toThrow('requires reconnect and state reconciliation');
  });

  it('surfaces a browser rejection', async () => {
    const result = transport.requestBrowserCommand({ type: 'rejected_command' }, 500);
    await waitFor(() => requests.length === 1);
    client.send(JSON.stringify({
      type: 'command_result',
      requestId: requests[0].requestId,
      success: false,
      error: 'Browser refused the mutation',
    }));
    await expect(result).rejects.toThrow('Browser refused the mutation');
  });

  it('rejects and removes in-flight and queued commands on disconnect', async () => {
    const first = transport.requestBrowserCommand({ type: 'first' }, 500);
    const second = transport.requestBrowserCommand({ type: 'second' }, 500);
    await waitFor(() => requests.length === 1);

    client.close(1000, 'test disconnect');
    await once(client, 'close');

    await expect(first).rejects.toThrow('Browser disconnected before command completed');
    await expect(second).rejects.toThrow('Browser disconnected before command completed');
    expect(requests).toHaveLength(1);
  });
});
