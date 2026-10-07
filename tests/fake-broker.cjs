// In-memory MQTT 3.1.1 broker (QoS 0, retain, last will) for transport/discovery tests.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function readString(bytes, offset) {
  const len = (bytes[offset] << 8) | bytes[offset + 1];
  return { value: Buffer.from(bytes.slice(offset + 2, offset + 2 + len)), next: offset + 2 + len };
}

function encodeLength(len) {
  const out = [];
  do {
    let b = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) b |= 0x80;
    out.push(b);
  } while (len > 0);
  return out;
}

function publishPacket(topic, payload, retain) {
  const t = Buffer.from(topic);
  const body = [t.length >> 8, t.length & 0xff, ...t, ...payload];
  return Uint8Array.from([retain ? 0x31 : 0x30, ...encodeLength(body.length), ...body]);
}

class Broker {
  constructor() {
    this.retained = new Map();
    this.clients = new Set();
  }

  socketClass() {
    const broker = this;
    return class FakeWebSocket {
      constructor() {
        this.readyState = 0;
        this.topics = new Set();
        this.will = null;
        this.graceful = false;
        broker.clients.add(this);
        setImmediate(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          if (this.onopen) this.onopen();
        });
      }
      send(packet) { broker.handle(this, new Uint8Array(packet)); }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        broker.drop(this);
        if (this.onclose) setImmediate(() => this.onclose && this.onclose());
      }
      deliver(bytes) {
        setImmediate(() => {
          if (this.readyState === 1 && this.onmessage) this.onmessage({ data: Uint8Array.from(bytes).buffer });
        });
      }
    };
  }

  handle(client, bytes) {
    const type = bytes[0] >> 4;
    let offset = 1;
    while (bytes[offset] & 0x80) offset++;
    offset++;
    if (type === 1) { // CONNECT
      const flags = bytes[offset + 7];
      let pos = offset + 10;
      pos = readString(bytes, pos).next; // client id
      if (flags & 0x04) {
        const topic = readString(bytes, pos);
        const message = readString(bytes, topic.next);
        client.will = { topic: topic.value.toString(), payload: message.value, retain: !!(flags & 0x20) };
      }
      client.deliver([0x20, 0x02, 0x00, 0x00]);
    } else if (type === 8) { // SUBSCRIBE
      const id = [bytes[offset], bytes[offset + 1]];
      let pos = offset + 2;
      const codes = [];
      while (pos < bytes.length) {
        const topic = readString(bytes, pos);
        client.topics.add(topic.value.toString());
        pos = topic.next + 1;
        codes.push(0);
      }
      client.deliver([0x90, 2 + codes.length, ...id, ...codes]);
      for (const topic of client.topics) {
        if (this.retained.has(topic)) client.deliver(publishPacket(topic, this.retained.get(topic), true));
      }
    } else if (type === 3) { // PUBLISH
      const topic = readString(bytes, offset);
      this.publish(topic.value.toString(), bytes.slice(topic.next), !!(bytes[0] & 0x01));
    } else if (type === 12) { // PINGREQ
      if (!this.silent) client.deliver([0xd0, 0x00]);
    } else if (type === 14) { // DISCONNECT
      client.graceful = true;
    }
  }

  publish(topic, payload, retain) {
    if (retain) this.retained.set(topic, payload);
    for (const c of this.clients) {
      if (c.readyState === 1 && c.topics.has(topic)) c.deliver(publishPacket(topic, payload, false));
    }
  }

  drop(client) {
    this.clients.delete(client);
    if (!client.graceful && client.will) this.publish(client.will.topic, client.will.payload, client.will.retain);
  }

  // Simulates the network vanishing under matching clients (no close frames).
  kill(match) {
    for (const c of [...this.clients].filter(match)) {
      c.readyState = 3;
      this.drop(c);
    }
  }
}

// A browser-like context with its own CouchTransport (+ CouchDiscovery).
function loadContext(broker, extra) {
  const context = {
    crypto: webcrypto,
    WebSocket: broker.socketClass(),
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint32Array,
    ArrayBuffer,
    DataView,
    Promise,
    JSON,
    Math,
    Date,
    Error,
    btoa,
    atob,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ip: '203.0.113.7' }) }),
    ...extra
  };
  vm.createContext(context);
  for (const file of ['transport.js', 'discovery.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  return context;
}

function waitFor(check, timeout = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() - started > timeout) return reject(new Error('timed out'));
      setTimeout(poll, 5);
    })();
  });
}

module.exports = { Broker, loadContext, waitFor };
