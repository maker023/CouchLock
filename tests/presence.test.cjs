const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Broker, loadContext, waitFor } = require('./fake-broker.cjs');

const TOKEN = 'ab'.repeat(32);

function laptopAndPhone(broker) {
  const laptop = loadContext(broker).CouchTransport;
  const phone = loadContext(broker).CouchTransport;
  const presence = [];
  const messages = [];
  phone.onPresence((state) => presence.push(state));
  phone.onMessage((msg) => messages.push(msg));
  return { laptop, phone, presence, messages };
}

test('phone sees the laptop come online, vanish, and get revoked', async () => {
  const broker = new Broker();
  const { laptop, phone, presence } = laptopAndPhone(broker);

  await laptop.connect({ token: TOKEN, sessionId: 'l', presence: 'announce' });
  await waitFor(() => laptop.isConnected());
  await phone.connect({ token: TOKEN, sessionId: 'p', presence: 'watch' });
  await waitFor(() => presence.at(-1) === '1');

  broker.kill((c) => c.will); // laptop sleeps: no DISCONNECT, the broker publishes its will
  await waitFor(() => presence.at(-1) === '0');

  phone.disconnect();
  const late = loadContext(broker).CouchTransport;
  const latePresence = [];
  late.onPresence((state) => latePresence.push(state));
  await late.connect({ token: TOKEN, sessionId: 'p2', presence: 'watch' });
  await waitFor(() => latePresence.at(-1) === '0'); // retained: a phone opening later still knows

  const laptop2 = loadContext(broker).CouchTransport;
  await laptop2.connect({ token: TOKEN, sessionId: 'l', presence: 'announce' });
  await waitFor(() => latePresence.at(-1) === '1');

  laptop2.disconnect('x');
  await waitFor(() => latePresence.at(-1) === 'x');
  late.disconnect();
  laptop.disconnect();
});

test('encrypted messages still flow alongside presence', async () => {
  const broker = new Broker();
  const { laptop, phone, messages } = laptopAndPhone(broker);
  await laptop.connect({ token: TOKEN, sessionId: 'l', presence: 'announce' });
  await phone.connect({ token: TOKEN, sessionId: 'p', presence: 'watch' });
  await waitFor(() => laptop.isConnected() && phone.isConnected());
  await laptop.send({ type: 'ready' });
  await waitFor(() => messages.some((m) => m.type === 'ready'));
  laptop.disconnect();
  phone.disconnect();
});

test('a socket that stops answering pings is replaced', async () => {
  const broker = new Broker();
  const ctx = loadContext(broker);
  const transport = ctx.CouchTransport;
  const statuses = [];
  transport.onStatus((s) => statuses.push(s));
  await transport.connect({ token: TOKEN, sessionId: 'l' });
  await waitFor(() => transport.isConnected());
  const before = broker.clients.size;

  // Shorten the watchdog: run the transport with a fast setTimeout for the pong wait.
  broker.silent = true;
  const realSetTimeout = ctx.setTimeout;
  ctx.setTimeout = (fn, ms) => realSetTimeout(fn, ms === 10000 ? 20 : ms);
  transport.checkAlive();
  await waitFor(() => statuses.includes('disconnected'));
  broker.silent = false;
  await waitFor(() => statuses.at(-1) === 'connected');
  assert.ok(broker.clients.size >= before, 'reconnected with a fresh socket');
  ctx.setTimeout = realSetTimeout;
  transport.disconnect();
});
