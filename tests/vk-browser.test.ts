import {it,expect,vi,afterEach} from 'vitest';
import {readVkPlayer} from '../src/vk';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
function setup(controller:AbortController, cancel=false) {
  let listener:(event:unknown)=>void=()=>{};
  const remove=vi.fn(async()=>{});
  const removeListener=vi.fn();
  const create=vi.fn(async()=>({id:41}));
  const update=vi.fn(async (_id:number,change:{url?:string})=>{
    if (!change.url) return;
    if (cancel) { controller.abort(); return; }
    listener({tabId:99,statusCode:200,url:'https://cdn.okcdn.ru/foreign',responseHeaders:[{name:'Content-Type',value:'application/dash+xml'}]});
    listener({tabId:41,statusCode:200,url:'https://cdn.okcdn.ru/opaque?sig=test',responseHeaders:[{name:'Content-Type',value:'application/dash+xml'}]});
  });
  vi.stubGlobal('browser',{tabs:{create,update,remove,get:vi.fn(async()=>({url:'https://vkvideo.ru/video-202202486_456252294'}))},webRequest:{onHeadersReceived:{addListener:vi.fn(fn=>{listener=fn;}),removeListener}}});
  return {remove,removeListener,create,update};
}
it('captures only the temporary VK tab and closes it after receiving the master',async()=>{
  const controller=new AbortController();const mocks=setup(controller);
  expect(await readVkPlayer('http://vk.com/video-202202486_456252294',controller.signal)).toEqual([{url:'https://cdn.okcdn.ru/opaque?sig=test',format:'dash'}]);
  expect(mocks.create).toHaveBeenCalledWith({url:'about:blank',active:false});
  expect(mocks.update).toHaveBeenCalledWith(41,{muted:true});
  expect(mocks.remove).toHaveBeenCalledWith(41);
  expect(mocks.removeListener).toHaveBeenCalledTimes(1);
});
it('activates only when requested, mutes first, and restores the previous tab',async()=>{
  const controller=new AbortController();const mocks=setup(controller);
  Object.assign(browser.tabs,{query:vi.fn(async()=>[{id:5}]),get:vi.fn(async()=>({url:'https://vkvideo.ru/video-202202486_456252294',active:true}))});
  await readVkPlayer('https://vkvideo.ru/video-202202486_456252294',controller.signal,true);
  expect(mocks.update.mock.calls).toEqual([[41,{muted:true}],[41,{url:'https://vkvideo.ru/video-202202486_456252294',active:true}],[5,{active:true}]]);
  expect(mocks.remove).toHaveBeenCalledWith(41);
});
it('does not move focus back when the user has already left the checking tab',async()=>{
  const controller=new AbortController();const mocks=setup(controller);
  Object.assign(browser.tabs,{query:vi.fn(async()=>[{id:5}]),get:vi.fn(async()=>({url:'https://vkvideo.ru/video-202202486_456252294',active:false}))});
  await readVkPlayer('https://vkvideo.ru/video-202202486_456252294',controller.signal,true);
  expect(mocks.update).not.toHaveBeenCalledWith(5,{active:true});
});
it('restores the previous tab after cancellation of an active check',async()=>{
  const controller=new AbortController();const mocks=setup(controller,true);
  Object.assign(browser.tabs,{query:vi.fn(async()=>[{id:5}]),get:vi.fn(async()=>({active:true}))});
  await expect(readVkPlayer('https://vkvideo.ru/video-202202486_456252294',controller.signal,true)).rejects.toThrow();
  expect(mocks.remove).toHaveBeenCalledWith(41);
  expect(mocks.update).toHaveBeenCalledWith(5,{active:true});
});
it('closes its temporary tab and listener when collection is cancelled',async()=>{
  const controller=new AbortController();const mocks=setup(controller,true);
  await expect(readVkPlayer('https://vkvideo.ru/video-202202486_456252294',controller.signal)).rejects.toThrow();
  expect(mocks.remove).toHaveBeenCalledWith(41);
  expect(mocks.removeListener).toHaveBeenCalledTimes(1);
});
it('uses page resource probes when no network event was observed',async()=>{
  const controller=new AbortController();const mocks=setup(controller);
  mocks.update.mockImplementation(async()=>{});
  const executeScript=vi.fn().mockResolvedValueOnce([{frameId:0,result:{resources:[],videos:0,play:'ожидание'}},{frameId:7,result:{resources:['https://cdn.okcdn.ru/opaque'],videos:1,play:'запущен'}}])
    .mockResolvedValueOnce([{result:'application/dash+xml'}]);
  Object.assign(browser,{scripting:{executeScript}});
  expect(await readVkPlayer('https://vkvideo.ru/video-202202486_456252294',controller.signal)).toEqual([{url:'https://cdn.okcdn.ru/opaque',format:'dash'}]);
  expect(mocks.remove).toHaveBeenCalledWith(41);
  expect(executeScript.mock.calls[0][0].target).toEqual({tabId:41,allFrames:true});
  expect(executeScript.mock.calls[1][0].target).toEqual({tabId:41,frameIds:[7]});
});
it('preserves clip routes instead of silently replacing them with video routes',async()=>{
  const controller=new AbortController();const mocks=setup(controller);
  await readVkPlayer('http://vk.com/clip-202202486_456252294',controller.signal);
  expect(mocks.update).toHaveBeenCalledWith(41,{url:'https://vkvideo.ru/clip-202202486_456252294'});
});
it('times out and cleans up when the player never exposes a manifest',async()=>{
  vi.useFakeTimers();
  const controller=new AbortController();const mocks=setup(controller);
  mocks.update.mockImplementation(async()=>{});
  Object.assign(browser,{scripting:{executeScript:vi.fn(async()=>[{result:{resources:[],videos:1,play:'NotAllowedError'}}])}});
  const promise=readVkPlayer('https://vkvideo.ru/video-202202486_456252294',controller.signal);
  const assertion=expect(promise).rejects.toThrow('NotAllowedError');
  await vi.advanceTimersByTimeAsync(26000);
  await assertion;
  expect(mocks.remove).toHaveBeenCalledWith(41);
  expect(mocks.removeListener).toHaveBeenCalledTimes(1);
});
