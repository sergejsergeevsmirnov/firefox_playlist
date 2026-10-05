/* Runs only in the disposable test bundle, never shipped in dist. */
(async () => {
  const checks = [];
  const checkpoint = text => fetch('http://127.0.0.1:8765/checkpoint', { method: 'POST', body: text }).catch(() => {});
  const assert = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); void checkpoint(label); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const send = async (type, payload = {}) => {
    const result = await Promise.race([browser.runtime.sendMessage({ type, ...payload }), wait(15000).then(() => { throw new Error(`Message timeout: ${type}`); })]);
    if (result?.error) throw new Error(result.error); return result;
  };
  const until = async (check, limit = 20000) => {
    const start = Date.now(); while (Date.now() - start < limit) { const value = await check(); if (value) return value; await wait(250); } throw new Error('Timed out waiting for condition');
  };
  let snapshot;
  try {
    assert(await browser.permissions.contains({ origins: ['http://127.0.0.1/*'] }), 'Disposable test origin permission granted');
    const runnerTab = await browser.tabs.getCurrent();
    const tab = await browser.tabs.create({ url: 'http://127.0.0.1:8765/page', active: false });
    await until(async () => { const live = await browser.tabs.get(tab.id); return live.url === 'http://127.0.0.1:8765/page' && live.status === 'complete'; });
    await browser.tabs.update(runnerTab.id, { active: true });
    await checkpoint('Fixture page loaded'); await send('start', { tabId: tab.id }); await checkpoint('Collector started');
    snapshot = await until(async () => { const data = await send('getState'); return data.state.queue.length >= 3 ? data : undefined; });
    assert(snapshot.state.queue.length === 3, 'HTML5, dynamic link, and iframe sources automatically queued without duplicates');
    const ids = snapshot.state.queue; const first = snapshot.state.videos[ids[0]];
    assert(first.variants[0].height > 0 && first.duration > 0, 'Firefox decoded real MP4 metadata');
    assert(first.variants[0].portable === true, 'Anonymous MP4 probe confirms export eligibility');
    await send('remove', { id: ids[0] });
    await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => { document.querySelector('video').setAttribute('title', 'Updated metadata'); document.querySelector('video').dispatchEvent(new Event('loadedmetadata')); } });
    await wait(1500);
    assert(!(await send('getState')).state.queue.includes(ids[0]), 'Removed video stays suppressed during active collection');
    await send('progress', { id: ids[1], position: 2.5 });
    assert((await browser.storage.local.get('state')).state.videos[ids[1]].position === 2.5, 'Playback position is persisted');
    const previousToken = snapshot.sessions[tab.id].token;
    await browser.tabs.update(tab.id, { url: 'http://127.0.0.1:8765/new-search?q=2' });
    await until(async () => (await send('getState')).sessions[tab.id]?.token !== previousToken);
    assert((await send('getState')).sessions[tab.id].ids.length === 0, 'Navigation rotates session and isolates old discovery results');
    await send('stop', { tabId: tab.id }); await checkpoint('Collector stopped');
    const player = document.createElement('iframe'); player.style.cssText = 'width:1200px;height:900px'; player.src = browser.runtime.getURL('player.html'); document.body.append(player);
    player.addEventListener('load', () => { void checkpoint('Player iframe loaded'); });
    await until(() => player.contentDocument?.querySelector('#play')); await checkpoint('Player UI rendered');
    await until(() => player.contentDocument.querySelector('.playlist-item')); await checkpoint('Player queue rendered');
    player.contentDocument.querySelector('#play').click();
    const media = await until(() => { const v = player.contentDocument.querySelector('video'); return v?.readyState >= 2 ? v : undefined; });
    // Test harness supplies a real user-activation equivalent only for media playback.
    media.muted = true; await media.play();
    await until(() => media.currentTime > 0.2);
    assert(media.currentTime > 0, 'Packaged player loads and plays the MP4 stream in Firefox');
    const beforeNext = media.currentSrc;
    player.contentDocument.querySelector('#next').click();
    await until(() => media.currentSrc && media.currentSrc !== beforeNext && media.readyState >= 2);
    assert(media.currentSrc !== beforeNext, 'Next-item control loads the following source');
    const sidebar = document.createElement('iframe'); sidebar.style.cssText = 'width:390px;height:950px'; sidebar.src = browser.runtime.getURL('sidebar.html'); document.body.append(sidebar);
    await until(() => sidebar.contentDocument?.querySelector('#filters'));
    assert(sidebar.contentDocument.documentElement.scrollWidth <= 390, 'Sidebar fits a 390px viewport');
    let playlist;
    const anchorPrototype = sidebar.contentWindow.HTMLAnchorElement.prototype;
    const originalClick = anchorPrototype.click;
    const originalBlobUrl = sidebar.contentWindow.URL.createObjectURL;
    sidebar.contentWindow.URL.createObjectURL = blob => { playlist = blob.text(); return originalBlobUrl(blob); };
    anchorPrototype.click = function () { if (!this.download?.endsWith('.m3u8')) originalClick.call(this); };
    sidebar.contentDocument.querySelector('#export').click();
    await until(() => playlist); playlist = await playlist; anchorPrototype.click = originalClick; sidebar.contentWindow.URL.createObjectURL = originalBlobUrl;
    assert(playlist.startsWith('#EXTM3U\n') && playlist.split('#EXTINF:').length === 3, 'Sidebar exports both playable entries as a real M3U8 blob');
    const quality = sidebar.contentDocument.querySelector('[name="minHeight"]');
    assert(quality?.tagName === 'SELECT' && !sidebar.contentDocument.querySelector('[name="format"], [name="live"]'), 'Compact quality selector replaces advanced input fields');
    quality.value = '4320'; quality.dispatchEvent(new sidebar.contentWindow.Event('change', { bubbles: true }));
    await until(async () => (await send('getState')).state.queue.length === 0);
    quality.value = ''; quality.dispatchEvent(new sidebar.contentWindow.Event('change', { bubbles: true }));
    await until(async () => (await send('getState')).state.queue.length === 2);
    assert(true, 'Dropdown filters apply immediately and preserve manually removed entries');
    sidebar.contentDocument.querySelector('#clear-queue').click();
    await until(async () => (await send('getState')).state.queue.length === 0);
    await send('quickFilters', { filters: {} });
    assert((await send('getState')).state.queue.length === 0, 'Clear queue prevents existing records from returning on filter change');
    const slowTab = await browser.tabs.create({ url: 'http://127.0.0.1:8765/slow-page', active: false });
    await until(async () => { const t = await browser.tabs.get(slowTab.id); return t.url?.endsWith('/slow-page') && t.status === 'complete'; });
    await send('start', { tabId: slowTab.id });
    const slowId = await until(async () => Object.values((await send('getState')).state.videos).find(v => v.title === 'Медленное видео')?.id);
    await browser.tabs.update(slowTab.id, { url: 'http://127.0.0.1:8765/new-search?q=slow' });
    await wait(4500);
    assert(!(await send('getState')).state.queue.includes(slowId), 'Late metadata from a previous search cannot enter the new session queue');
    await send('stop', { tabId: slowTab.id });
    const expiryTab = await browser.tabs.create({ url: 'http://127.0.0.1:8765/expiring', active: false });
    await until(async () => { const t = await browser.tabs.get(expiryTab.id); return t.url?.endsWith('/expiring') && t.status === 'complete'; });
    await send('start', { tabId: expiryTab.id });
    const expiryItem = await until(async () => Object.values((await send('getState')).state.videos).find(v => v.title === 'Истекающая ссылка' && v.status === 'ready'));
    await send('stop', { tabId: expiryTab.id }); await fetch('http://127.0.0.1:8765/invalidate', { method: 'POST' });
    const expiryControl = await until(() => [...player.contentDocument.querySelectorAll('.playlist-item')].find(b => b.textContent.startsWith('Истекающая ссылка')));
    expiryControl.click();
    await until(() => media.currentSrc.includes('renewed=1') && media.readyState >= 2 && media.currentTime > 0.2, 40000);
    assert((await send('getState')).state.videos[expiryItem.id].variants.some(v => v.url.includes('renewed=1')), 'Expired media URL is refreshed from the original page and playback resumes');
    media.pause();
    if (testStreams) {
      const streamTab = await browser.tabs.create({ url: 'http://127.0.0.1:8765/adaptive', active: false });
      await until(async () => { const t = await browser.tabs.get(streamTab.id); return t.url?.endsWith('/adaptive') && t.status === 'complete'; });
      await send('start', { tabId: streamTab.id });
      const streamState = await until(async () => {
        const { state } = await send('getState'); const items = Object.values(state.videos).filter(v => v.title.startsWith('Тест '));
        if (items.length === 2 && items.every(v => v.status !== 'checking')) return state;
      }, 80000);
      for (const title of ['Тест HLS', 'Тест DASH']) {
        const item = Object.values(streamState.videos).find(v => v.title === title);
        assert(item.status === 'ready', `${title} resolver ready: ${item.reason || 'OK'}`);
        const control = await until(() => [...player.contentDocument.querySelectorAll('.playlist-item')].find(b => b.textContent.startsWith(title)));
        control.click();
        await until(() => player.contentDocument.querySelector('#title').textContent === title && media.readyState >= 2 && media.currentTime > 0.2, 40000);
        assert(media.videoHeight > 0, `${title} decoded and played through the packaged adaptive library`);
        media.pause();
      }
      await send('stop', { tabId: streamTab.id });
    }
    for (const provider of [...(testRutube ? [{name:'Rutube',url:'http://rutube.ru/video/9152193bdfcc0ebe043af2eedabe41d7/',duration:71}] : []), ...(testOk ? [{name: "OK",url: "http://ok.ru/video/8809471543997",duration:75}] : []), ...(testDzen ? [{name:'Dzen',url:'http://dzen.ru/video/watch/65635213b4cb715fa04a16b3?f=video',duration:1427}] : [])]) {
      await send('start', {tabId:tab.id});
      const token = (await send('getState')).sessions[tab.id].token;
      await browser.scripting.executeScript({target:{tabId:tab.id},args:[token,provider],func: (token,p) => browser.runtime.sendMessage({type:'discovered',pageUrl:location.href,token,candidates:[{sourceUrl:p.url,identity:p.name+'-test',title:p.name+' regression',duration:p.duration,expectedDuration:p.duration,discovery:'catalog',variants:[]}],frames:[],previews:[]})});
      let item = await until(async () => { const v = (await send('getState')).state.videos[provider.name+'-test']; return v && v.status !== 'checking' ? v : undefined; }, 80000);
      assert(item.status === 'ready', `${provider.name} full source resolved: ${item.reason || 'OK'}`);
      if (provider.name === 'Dzen') assert(!(await browser.tabs.query({})).some(t => t.url?.startsWith('https://dzen.ru/video/watch/')), 'Temporary Dzen inspection tab is closed');
      assert(Math.abs(item.duration-provider.duration)<3 && item.variants.some(v => v.height >= (provider.name === "OK" ? 360 : 1080) && v.portable), provider.name+' full duration and high quality verified for export');
      const control = await until(() => [...player.contentDocument.querySelectorAll('.playlist-item')].find(b => b.textContent.startsWith(provider.name+' regression')));
      control.click();
      await until(() => player.contentDocument.querySelector('#title').textContent === provider.name+' regression' && media.readyState >= 2 && media.currentTime > .2, 40000);
      assert(media.videoHeight >= (provider.name === "OK" ? 360 : 720), 'User '+provider.name+' video decodes in packaged Firefox player'); media.pause();
      await send('stop', {tabId:tab.id});
    }
    const networkTab = await browser.tabs.create({url:'http://127.0.0.1:8765/new-search?q=network',active:false});
    await until(async () => { const t = await browser.tabs.get(networkTab.id); return t.url === 'http://127.0.0.1:8765/new-search?q=network' && t.status === 'complete'; });
    await send('start',{tabId:networkTab.id});
    await browser.scripting.executeScript({target:{tabId:networkTab.id},func:async () => { await fetch('/master.m3u8'); }});
    const captured = await until(async () => Object.values((await send('getState')).state.videos).find(v=>v.status==='ready' && v.variants.some(x=>x.url==='http://127.0.0.1:8765/master.m3u8')));
    assert((await send('getState')).state.queue.includes(captured.id), 'Network-only HLS request is resolved and automatically queued');
    await browser.scripting.executeScript({target:{tabId:networkTab.id},func:async () => { await fetch('/dash-no-extension'); }});
    const dashCapture = await until(async () => Object.values((await send('getState')).state.videos).find(v=>v.status==='ready' && v.variants.some(x=>x.url==='http://127.0.0.1:8765/dash-no-extension')));
    assert(dashCapture.variants.some(v=>v.format==='dash' && v.height===720 && v.audio) && (await send('getState')).state.queue.includes(dashCapture.id), 'Extensionless DASH is recognized by MIME with audio and queued');
    await send('stop',{tabId:networkTab.id});
    snapshot = await send('getState');
    await fetch('http://127.0.0.1:8765/report', { method: 'POST', body: JSON.stringify({ ok: true, checks, playlist, queue: snapshot.state.queue.length, userAgent: navigator.userAgent }) });
  } catch (error) {
    await fetch('http://127.0.0.1:8765/report', { method: 'POST', body: JSON.stringify({ ok: false, checks, error: String(error), snapshot: await send('getState').catch(() => snapshot), userAgent: navigator.userAgent }) });
  }
})();

