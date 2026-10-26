const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { Broker, loadContext, waitFor } = require('./fake-broker.cjs');

function delayedCrypto(operation) {
  let release;
  let started = false;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    release, started: () => started,
    crypto: {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      subtle: new Proxy(webcrypto.subtle, {
        get(target, name) {
          if (name !== operation) return target[name].bind(target);
          return (...args) => {
            const result = target[name](...args);
            if (started) return result;
            started = true;
            return result.then(async (value) => { await gate; return value; });
          };
        }
      })
    }
  };
}

for (const operation of ['encrypt', 'decrypt']) {
  test(`delayed ${operation} cannot reverse media snapshots`, async () => {
    const broker = new Broker();
    const delay = delayedCrypto(operation);
    const sender = loadContext(broker, operation === 'encrypt' ? { crypto: delay.crypto } : {}).CouchTransport;
    const receiver = loadContext(broker, operation === 'decrypt' ? { crypto: delay.crypto } : {}).CouchTransport;
    const received = [];
    receiver.onMessage((msg) => received.push(msg.sequence));
    try {
      await sender.connect({ token: 'aa'.repeat(32), sessionId: 'sender' });
      await receiver.connect({ token: 'aa'.repeat(32), sessionId: 'receiver' });
      await waitFor(() => sender.isConnected() && receiver.isConnected());
      const first = sender.send({ sequence: 1, playing: true });
      const second = sender.send({ sequence: 2, playing: false });
      await waitFor(delay.started);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(received, [], 'later state waits for earlier state');
      delay.release();
      await Promise.all([first, second]);
      await waitFor(() => received.length === 2);
      assert.deepEqual(received, [1, 2]);
    } finally { delay.release(); sender.disconnect(); receiver.disconnect(); }
  });
}

test('a decrypted snapshot from before reconnect is discarded', async () => {
  const broker = new Broker();
  const delay = delayedCrypto('decrypt');
  const sender = loadContext(broker).CouchTransport;
  const receiver = loadContext(broker, { crypto: delay.crypto }).CouchTransport;
  const received = [];
  receiver.onMessage((msg) => received.push(msg.title));
  try {
    await sender.connect({ token: 'aa'.repeat(32), sessionId: 'sender' });
    await receiver.connect({ token: 'aa'.repeat(32), sessionId: 'receiver' });
    await waitFor(() => sender.isConnected() && receiver.isConnected());
    await sender.send({ title: 'Stale episode' });
    await waitFor(delay.started);
    receiver.reconnectNow();
    await waitFor(() => receiver.isConnected());
    await sender.send({ title: 'Current episode' });
    await waitFor(() => received.length === 1);
    delay.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(received, ['Current episode']);
  } finally { delay.release(); sender.disconnect(); receiver.disconnect(); }
});

test('phone and extension transports remain identical', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'transport.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'extension', 'transport.js'), 'utf8'));
});

for (const file of ['transport.js', 'extension/transport.js']) {
  test(`${file} waits for a complete SUBACK before publishing`, async () => {
    const sockets = [];
    class FakeWebSocket {
      constructor() {
        this.readyState = 0;
        this.sent = [];
        sockets.push(this);
      }
      send(packet) { this.sent.push(new Uint8Array(packet)); }
      close() {
        this.readyState = 3;
        if (this.onclose) this.onclose();
      }
      open() {
        this.readyState = 1;
        this.onopen();
      }
      receive(bytes) {
        this.onmessage({ data: Uint8Array.from(bytes).buffer });
      }
    }

    const context = {
      crypto: webcrypto,
      WebSocket: FakeWebSocket,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      ArrayBuffer,
      setTimeout,
      clearTimeout,
      setInterval: () => 1,
      clearInterval: () => {}
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    const transport = context.CouchTransport;
    const statuses = [];
    transport.onStatus((status) => statuses.push(status));
    await transport.connect({ token: '11'.repeat(32), sessionId: 'test' });

    const socket = sockets[0];
    socket.open();
    socket.receive([0x20, 0x02, 0x00, 0x00]);
    assert.equal(socket.sent.at(-1)[0], 0x82, 'subscribes after CONNACK');
    assert.equal(transport.isConnected(), false);
    assert.equal(await transport.send({ type: 'hello' }), false);

    socket.receive([0x90, 0x03, 0x00]);
    assert.equal(transport.isConnected(), false, 'partial SUBACK is buffered');
    socket.receive([0x01, 0x00]);
    assert.equal(transport.isConnected(), true);
    assert.equal(statuses.at(-1), 'connected');
    assert.equal(await transport.send({ type: 'hello' }), true);
    assert.equal(socket.sent.at(-1)[0], 0x30, 'publishes after subscription');

    transport.disconnect();
    assert.equal(socket.onclose, null, 'old socket cannot start a second reconnect');
    assert.equal(transport.isConnected(), false);
  });
}
