// Run only through the Playwright plugin: browser_run_code_unsafe({ filename: <this file> }).
// Uses an existing browser, an isolated context and stubbed APIs; never launches
// a provider or changes a real project/session. Build frontend to /tmp/ive-sidebar-ui/dist first.
async (page) => {
  const browser = page.context().browser();
  const origin = 'http://ive-sidebar.test';
  const dist = '/tmp/ive-sidebar-ui/dist';
  const checks = [], errors = [], writes = [], contexts = [], shots = [];
  const assert = (condition, name, detail) => { if (!condition) throw new Error(`${name}${detail ? ': ' + JSON.stringify(detail) : ''}`); checks.push(name); };
  const workspace = {id:'sidebar-fixture',name:'Sidebar test project',path:'/isolated/sidebar-fixture',default_worktree:0};
  async function fixture(width, theme='light') {
    const context = await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce',serviceWorkers:'block'});
    contexts.push(context);
    await context.addInitScript((theme) => {
      localStorage.setItem('ive.onboarding.v2.owner','done');
      localStorage.setItem('cc-pwa-install-dismissed-v1','1');
      localStorage.setItem('cc-soundEnabled','0');
      localStorage.setItem('ive-theme.v2',theme);
    },theme);
    await context.routeWebSocket('**/*',socket => { socket.onMessage(() => {}); });
    await context.route('**/*', async route => {
      const req=route.request(), url=new URL(req.url());
      if (url.origin !== origin) return route.fulfill({status:403,body:'Isolated sidebar fixture: external request blocked'});
      if (!url.pathname.startsWith('/api/')) {
        const path=decodeURIComponent(url.pathname);
        if(path.includes('..')) return route.fulfill({status:403,body:'Invalid path'});
        try { return await route.fulfill({path:dist+(path==='/'?'/index.html':path)}); }
        catch { return route.fulfill({status:404,body:'Missing fixture asset'}); }
      }
      const p=url.pathname.slice(4), method=req.method();
      if(method!=='GET') { writes.push({method,path:p}); return route.fulfill({status:403,json:{error:'This test never writes to a backend'}}); }
      let value=[];
      if(p==='/whoami') value={actor_kind:'localhost',mode:'full',label:'Sidebar fixture'};
      else if(p==='/settings') value={product_tour_version:'2',owner_name:'UI test'};
      else if(p.startsWith('/settings/')) value={value:p.endsWith('/product_tour_version')?'2':null};
      else if(p==='/workspaces') value=[workspace];
      else if(p==='/quick-start') value={root:'/isolated/sidebar-fixture',workspace_id:null,workspace_name:'Quick sessions'};
      else if(p==='/cli-info') value={available_clis:{claude:true},version:'sidebar-fixture'};
      else if(p==='/cli-info/features') value={profiles:{}};
      else if(p==='/model-providers') value={providers:[],health:[]};
      else if(p==='/runtime/status') value={multiplayer:{enabled:false},tunnel:{running:false}};
      else if(p==='/sidechat/options') value={providers:[],accounts:[]};
      else if(p==='/extensions') value={edition:'integrated-dev',extensions:[{id:'sandbox'}]};
      else if(p==='/overview') value={workspace_total:1,detail_limit:5,workspaces:[]};
      else if(p.endsWith('/files')) value={items:[]};
      else if(p.endsWith('/brainstormer')) value={};
      else if(p==='/phone/status') value={is_local_owner:true,is_device:false,urls:[],tunnel:{running:false}};
      return route.fulfill({json:value});
    });
    const p=await context.newPage();
    p.setDefaultTimeout(10000);
    p.on('pageerror',error=>errors.push(error.message));
    await p.goto(origin);
    await p.locator('.x-app-shell').waitFor();
    return p;
  }
  try {
    const p=await fixture(1440);
    let toggle=p.getByRole('button',{name:'Hide sidebar',exact:true});
    await toggle.waitFor();
    await p.getByRole('complementary',{name:'Projects and sessions'}).waitFor();
    assert(await toggle.getAttribute('aria-expanded')==='true','Expanded state and accessible toggle are exposed');
    const before=await p.locator('.x-app-main').boundingBox();
    await toggle.click();
    toggle=p.getByRole('button',{name:'Show sidebar',exact:true});
    await toggle.waitFor();
    assert(await p.locator('#ive-project-sidebar').count()===0,'Collapsed sidebar leaves no hidden interactive controls');
    assert(await toggle.getAttribute('aria-expanded')==='false','Expand control stays available after collapsing');
    const after=await p.locator('.x-app-main').boundingBox();
    assert(after.width>before.width+200,'Collapsing gives the workspace real horizontal space',{before,after});
    assert(await p.evaluate(()=>localStorage.getItem('ive.sidebar-visible'))==='false','Click persists the preference');
    await p.reload();
    toggle=p.getByRole('button',{name:'Show sidebar',exact:true});
    await toggle.waitFor();
    assert(await p.locator('#ive-project-sidebar').count()===0,'Reload restores collapsed state');
    await toggle.focus();
    await p.keyboard.press('Tab');
    assert(!(await toggle.evaluate(el=>el===document.activeElement)),'Tab exits the toggle without a focus trap');
    await toggle.focus();
    await p.keyboard.press('Space');
    await p.getByRole('button',{name:'Hide sidebar',exact:true}).waitFor();
    await p.getByRole('complementary',{name:'Projects and sessions'}).waitFor();
    assert(await p.evaluate(()=>localStorage.getItem('ive.sidebar-visible'))==='true','Space expands and persists the visible state');
    await p.getByRole('searchbox',{name:'Filter sessions by name or model'}).focus();
    await p.keyboard.press('Meta+Backslash');
    toggle=p.getByRole('button',{name:'Show sidebar',exact:true});
    await toggle.waitFor();
    assert(await toggle.evaluate(el=>el===document.activeElement),'Shortcut from removed sidebar field restores focus to the recovery button');
    assert(await p.evaluate(()=>localStorage.getItem('ive.sidebar-visible'))==='false','Existing keyboard shortcut also persists');
    await p.keyboard.press('Enter');
    await p.getByRole('button',{name:'Hide sidebar',exact:true}).waitFor();
    assert(await p.locator('#ive-project-sidebar').count()===1,'Enter expands without duplicating the sidebar');

    for(const width of [1680,1280,1024,768]) {
      await p.setViewportSize({width,height:900});
      toggle=p.getByRole('button',{name:'Hide sidebar',exact:true});
      await toggle.waitFor();
      let box=await toggle.boundingBox();
      assert(box && box.x>=0 && box.x+box.width<=width && box.height>=36,'Expanded toggle remains reachable at '+width+'px',box);
      await toggle.click();
      toggle=p.getByRole('button',{name:'Show sidebar',exact:true});
      await toggle.waitFor();
      box=await toggle.boundingBox();
      assert(box && box.x>=0 && box.x+box.width<=width,'Collapsed toggle remains reachable at '+width+'px',box);
      if(width===1280) { const path='/tmp/ive-sidebar-ui/sidebar-collapsed-1280.png';await p.screenshot({path});shots.push(path); }
      await toggle.click();
    }
    await p.setViewportSize({width:390,height:844});
    await p.getByRole('button',{name:'Open sidebar',exact:true}).waitFor();
    assert(await p.locator('[data-sidebar-toggle]').count()===0,'Phone viewport retains its existing drawer, with no desktop toggle');
    await p.getByRole('button',{name:'Open sidebar',exact:true}).click();
    await p.getByRole('dialog',{name:'Sidebar',exact:true}).waitFor();
    await p.keyboard.press('Escape');
    await p.getByRole('dialog',{name:'Sidebar',exact:true}).waitFor({state:'hidden'});
    assert(true,'Existing mobile drawer still opens and closes with Escape');
    await p.setViewportSize({width:1440,height:900});
    await p.getByRole('button',{name:'Hide sidebar',exact:true}).waitFor();
    assert(await p.evaluate(()=>localStorage.getItem('ive.sidebar-visible'))==='true','Viewport changes do not overwrite desktop preference');
    const light='/tmp/ive-sidebar-ui/sidebar-expanded-1440.png';await p.screenshot({path:light});shots.push(light);

    const dark=await fixture(1680,'dark');
    await dark.getByRole('button',{name:'Hide sidebar',exact:true}).waitFor();
    const darkPath='/tmp/ive-sidebar-ui/sidebar-dark-1680.png';await dark.screenshot({path:darkPath});shots.push(darkPath);
    assert(errors.length===0,'No JavaScript page errors',errors);
    assert(writes.length===0,'Sidebar operations never write projects, sessions or backend settings',writes);
    return {kind:'Full built app; isolated API/WebSocket fixtures; not a native app or provider test',passed:checks.length,checks,errors,writes,screenshots:shots};
  } finally { await Promise.all(contexts.map(context=>context.close())); }
}
