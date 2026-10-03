const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

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
