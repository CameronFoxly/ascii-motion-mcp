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

  it('does not dispatch a request that was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(transport.requestBrowserCommand(
      { type: 'cancelled' }, 500, undefined, undefined, undefined, 3, controller.signal,
    )).rejects.toMatchObject({ code: 'BUSY' });
    expect(requests).toHaveLength(0);
  });

  it('removes a cancelled queued request without interrupting its neighbors', async () => {
    const first = transport.requestBrowserCommand({ type: 'first' }, 500);
    const controller = new AbortController();
    const cancelled = transport.requestBrowserCommand(
      { type: 'cancelled' }, 500, undefined, undefined, undefined, 3, controller.signal,
    );
    const cancelledExpectation = expect(cancelled).rejects.toMatchObject({ code: 'BUSY' });
    const last = transport.requestBrowserCommand({ type: 'last' }, 500);
    await waitFor(() => requests.length === 1);
    controller.abort();
    await cancelledExpectation;
    client.send(JSON.stringify({ type: 'command_result', requestId: requests[0].requestId, success: true }));
    await first;
    await waitFor(() => requests.length === 2);
    expect(requests[1].command.type).toBe('last');
    client.send(JSON.stringify({ type: 'command_result', requestId: requests[1].requestId, success: true }));
    await last;
    controller.abort();
    expect(requests).toHaveLength(2);
  });

  it('quarantines an active cancellation instead of claiming an edit was rolled back', async () => {
    const controller = new AbortController();
    const active = transport.requestBrowserCommand(
      { type: 'active' }, 500, undefined, undefined, undefined, 3, controller.signal,
    );
    const activeExpectation = expect(active).rejects.toMatchObject({
      code: 'BUSY', details: { browserMayHaveApplied: true },
    });
    const queued = transport.requestBrowserCommand({ type: 'queued' }, 500);
    const queuedExpectation = expect(queued).rejects.toMatchObject({ code: 'BUSY' });
    await waitFor(() => requests.length === 1);
    controller.abort();
    await activeExpectation;
    await queuedExpectation;
    expect(requests).toHaveLength(1);
    await expect(transport.requestBrowserCommand({ type: 'unsafe_retry' })).rejects.toThrow('requires reconnect');
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
    const firstRejected = expect(first).rejects.toThrow('Browser disconnected before command completed');
    const secondRejected = expect(second).rejects.toThrow('Browser disconnected before command completed');
    await waitFor(() => requests.length === 1);

    client.close(1000, 'test disconnect');
    await once(client, 'close');

    await firstRejected;
    await secondRejected;
    expect(requests).toHaveLength(1);
  });

  async function hello() {
    client.send(JSON.stringify({
      type: 'hello', protocol: 'ascii-motion-bridge', protocolVersion: 3,
      contractVersion: '3.0.0', contractHash: 'fixture',
      app: { version: 'fixture' }, sessionId: 'session', tabId: 'tab',
      document: { documentId: 'document', projectId: null, name: 'Fixture', revision: 4 },
      capabilities: {
        operations: ['get_document'], ui: { history: true, typography: true, selection: true },
        auth: { signedIn: false }, entitlements: { maxLayers: 5, premium: false },
      },
    }));
    await waitFor(() => !!transport.browserHello);
  }

  it('correlates simultaneous v3 snapshot requests without replacing callbacks', async () => {
    await hello();
    const snapshots: unknown[] = [];
    const requestIds: string[] = [];
    transport.onStateSnapshot = snapshot => snapshots.push(snapshot);
    client.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'state_request') requestIds.push(message.requestId);
    });
    const first = transport.requestStateFromBrowser(500);
    const second = transport.requestStateFromBrowser(500);
    await waitFor(() => requestIds.length === 2);
    const reply = (requestId: string) => client.send(JSON.stringify({
      type: 'state_snapshot', requestId, protocolVersion: 3,
      document: { fixture: true }, documentId: 'document', revision: 4,
    }));
    reply(requestIds[1]);
    await expect(second).resolves.toBe(true);
    expect(snapshots).toHaveLength(1);
    reply('unmatched');
    reply(requestIds[0]);
    await expect(first).resolves.toBe(true);
    expect(snapshots).toHaveLength(2);
  });

  it('rejects stale/different-document snapshots and ignores late replies to expired requests', async () => {
    await hello();
    const snapshots: unknown[] = [];
    const requestIds: string[] = [];
    transport.onStateSnapshot = snapshot => snapshots.push(snapshot);
    client.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'state_request') requestIds.push(message.requestId);
    });
    const expired = transport.requestStateFromBrowser(30);
    await waitFor(() => requestIds.length === 1);
    await expect(expired).resolves.toBe(false);
    const current = transport.requestStateFromBrowser(100);
    await waitFor(() => requestIds.length === 2);
    for (const [requestId, documentId, revision] of [
      [requestIds[0], 'document', 4], [requestIds[1], 'document', 3], [requestIds[1], 'other-document', 5],
    ]) client.send(JSON.stringify({
      type: 'state_snapshot', requestId, documentId, revision, protocolVersion: 3, document: { fixture: true },
    }));
    await expect(current).resolves.toBe(false);
    expect(snapshots).toEqual([]);
    expect(transport.browserHello?.document).toMatchObject({ documentId: 'document', revision: 4 });
  });

  it('ignores acknowledgements from a second authenticated tab and does not promote it on disconnect', async () => {
    const other = new WebSocket(`ws://127.0.0.1:${transport.port}/?token=test-token`);
    await once(other, 'open');
    try {
      let settled = false;
      const result = transport.requestBrowserCommand({ type: 'owner-only' }, 500).finally(() => { settled = true; });
      await waitFor(() => requests.length === 1);
      other.send(JSON.stringify({ type: 'command_result', requestId: requests[0].requestId, success: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      expect(requests).toHaveLength(1);
      client.send(JSON.stringify({ type: 'command_result', requestId: requests[0].requestId, success: true }));
      await expect(result).resolves.toMatchObject({ success: true });
      const otherClosed = once(other, 'close');
      client.close();
      await once(client, 'close');
      await otherClosed;
      await expect(transport.requestBrowserCommand({ type: 'no-automatic-promotion' })).rejects.toThrow('No browser connected');
    } finally {
      if (other.readyState === WebSocket.OPEN) other.close();
    }
  });

  it('cleans up pending legacy exports and state requests immediately on disconnect', async () => {
    const snapshot = transport.requestStateFromBrowser(10_000);
    const exported = transport.requestExportFromBrowser({
      requestId: 'export', exportType: 'image', format: 'png', settings: {}, filename: 'test.png',
    }, 10_000);
    client.close();
    await once(client, 'close');
    await expect(snapshot).resolves.toBe(false);
    await expect(exported).resolves.toMatchObject({ success: false, error: 'Browser disconnected before export completed' });
  });
});
