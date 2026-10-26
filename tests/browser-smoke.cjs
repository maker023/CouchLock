// Optional real-browser checks, with synthetic players and no external services.
// Run: node --test tests/browser-smoke.cjs (CHROME_PATH overrides the executable).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { waitFor } = require('./fake-broker.cjs');
const root = path.join(__dirname, '..');
const chromePath = process.env.CHROME_PATH || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';

test('Chrome: nested cross-origin fullscreen and phone player UI', { skip: !fs.existsSync(chromePath), timeout: 30000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'couchlock-browser-'));
  const content = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');
  const bridge = `<script>
    window.reports = [];
    window.chrome = { runtime: { id: 'fixture', sendMessage(msg, cb) { reports.push(msg); if(cb) cb(); },
      onMessage: { addListener(fn) { window.command = msg => fn(msg, {}, () => {}); }, removeListener() {} } } };
    addEventListener('message', event => {
      if (event.data && event.data.fixtureCommand) {
        command(event.data.fixtureCommand);
        document.querySelectorAll('iframe').forEach(frame => frame.contentWindow.postMessage(event.data, '*'));
      }
    });
  </script>`;
  let port;
  let otherPort;
  const serve = (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/outer' || req.url === '/middle') {
      const next = req.url === '/outer' ? '/middle' : '/player';
      const framePort = req.url === '/outer' ? otherPort : port;
      res.end(`<style>iframe{width:400px;height:225px;border:0} .clipped{transform:translateX(5px);overflow:hidden;width:450px;height:260px}</style>
        <div class="clipped"><iframe src="http://127.0.0.1:${framePort}${next}"></iframe></div>${bridge}<script>${content}</script>`);
    } else if (req.url === '/player') {
      res.end(`<div class="video_container" style="width:400px;height:225px"><div style="width:400px;height:225px"><video style="width:100%;height:100%"></video></div></div>
        ${bridge}<script>${content}</script><script>
        addEventListener('message', event => { if(event.data && event.data.fixtureExpand) command({action:'playerExpand',token:'test-token'}); });
        </script>`);
    } else if (req.url.startsWith('/app')) {
      let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
      html = html.replace(/<link[^>]+href="https:[^"]*"[^>]*>/g, '');
      html = html.replace('<script src="transport.js?v=4"></script>', `<script>
        localStorage.setItem('couchlock-pairing-v1', JSON.stringify({token:'aa'.repeat(32),sessionId:'fixture'}));
        window.CouchTransport = {
          onStatus(fn) { this.status = fn; }, onPresence() {}, onMessage(fn) { this.message = fn; },
          connect() { queueMicrotask(() => { this.status('connected'); this.message({type:'ready'}); }); },
          send(msg) { return Promise.resolve(true); }, isConnected() {return true;}, disconnect(){}, reconnectNow(){}, checkAlive(){}
        };
        navigator.serviceWorker.register = () => Promise.resolve();
      </script>`);
      html = html.replace('<script src="discovery.js?v=1"></script>', '');
      res.end(html);
    } else { res.end(''); }
  };
  const server = http.createServer(serve);
  const otherServer = http.createServer(serve);
  server.listen(0);
  await once(server, 'listening');
  port = server.address().port;
  otherServer.listen(0);
  await once(otherServer, 'listening');
  otherPort = otherServer.address().port;
  const proc = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--user-data-dir=' + profile, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
  let ws;
  try {
    await waitFor(() => fs.existsSync(path.join(profile, 'DevToolsActivePort')), 10000);
    const debugPort = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    const tabs = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
    ws = new WebSocket(tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let seq = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text + ': ' + JSON.stringify(msg.params.exceptionDetails.exception));
      if (pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      }
    };
    function cdp(method, params = {}) {
      return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    }
    async function evaluate(expression, contextId) {
      const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/outer` });
    // Await complete loading of all three documents.
    let tree;
    for (let i = 0; i < 60; i++) {
      tree = await cdp('Page.getFrameTree');
      if (tree.frameTree.childFrames && tree.frameTree.childFrames[0].childFrames) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Cross-origin fixtures are accessed through CDP isolated worlds, not DOM access.
    const frames = [tree.frameTree, tree.frameTree.childFrames[0], tree.frameTree.childFrames[0].childFrames[0]];
    const contexts = [];
    for (const frame of frames) {
      const world = await cdp('Page.createIsolatedWorld', { frameId: frame.frame.id, worldName: 'geometry' });
      contexts.push(world.executionContextId);
    }
    await evaluate(`new Promise(resolve => { if(document.readyState === 'complete') resolve(); else addEventListener('load',resolve,{once:true}); })`);
    await evaluate(`postMessage({fixtureCommand:{action:'preparePlayerExpand',token:'test-token'}}, '*')`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await evaluate(`document.querySelector('iframe').contentWindow.postMessage({fixtureExpand:true}, '*')`, contexts[1]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await evaluate(`reports.some(msg => msg.type === 'playerExpanded')`), true);
    for (let i = 0; i < contexts.length; i++) {
      const dimensions = await evaluate(`(() => { const r = document.querySelector('${i === 2 ? 'video' : 'iframe'}').getBoundingClientRect(); return {width:r.width,height:r.height,vw:innerWidth,vh:innerHeight}; })()`, contexts[i]);
      assert.ok(Math.abs(dimensions.width - dimensions.vw) < 2 && Math.abs(dimensions.height - dimensions.vh) < 2, JSON.stringify({ frame: i, ...dimensions }));
    }
    await evaluate(`postMessage({fixtureCommand:{action:'playerRestore'}}, '*')`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await evaluate(`document.querySelector('iframe').getBoundingClientRect().width`), 400);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/app` });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await evaluate(`document.querySelector('.nav-btn[data-mode="media"]').click();
      CouchTransport.message({type:'media_status',platform:'netflix',title:'Test episode',playing:false,currentTime:120,duration:1800,skipIntroAvailable:true,nextEpisodeAvailable:true});`);
    assert.equal(await evaluate(`document.querySelector('#media-title').textContent`), 'Test episode');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#icon-play')).display !== 'none'`), true);
    assert.equal(await evaluate(`document.querySelector('#btn-play-pause').disabled`), false);
    assert.equal(await evaluate(`document.querySelector('#btn-next-ep').classList.contains('highlight')`), true);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
    assert.deepEqual(errors, []);
  } finally {
    if (ws) ws.close();
    proc.kill();
    await new Promise((resolve) => { if (proc.exitCode !== null) resolve(); else { proc.once('exit', resolve); setTimeout(resolve, 2000).unref(); } });
    server.close();
    otherServer.close();
    // The unique mkdtemp directory is the only cleanup target.
    assert.ok(path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
