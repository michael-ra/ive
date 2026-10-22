// Playwright-plugin filename entrypoint. Bundle PhonePanel with React into
// /tmp/ive-phone-setup-ui/harness.js first; all APIs below are isolated fixtures.
async (page) => {
  const browser=page.context().browser(), contexts=[], checks=[], errors=[], screenshots=[];
  const origin='http://ive-phone-setup.test',dir='/tmp/ive-phone-setup-ui';
  const assert=(ok,name)=>{if(!ok)throw new Error(name);checks.push(name)};
  const accepted={required:false,accepted:true,closed_lid_requested:true,allow_battery_requested:false};
  const tunnel={running:true,url:'https://setup-fixture.example',cloudflared_installed:true};
  const urls=[{url:tunnel.url,kind:'tunnel',label:'Secure tunnel',secure:true}];
  async function fixture(options={}) {
    const state={calls:[],statusFail:false,failSetup:false,failTunnel:false,failStop:false,approved:false,...options};
    state.status={desktop:true,is_local_owner:true,is_device:false,pin_enabled:false,pin_min_length:6,idle_minutes:15,setup:{required:true,accepted:false,closed_lid_requested:false,allow_battery_requested:false},availability:{state:'not_registered'},tunnel:{running:false,cloudflared_installed:true},urls:[],...(options.status||{})};
    const context=await browser.newContext({viewport:{width:1100,height:950},reducedMotion:'reduce',serviceWorkers:'block'});contexts.push(context);
    await context.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url()),method=req.method();
      if(url.origin!==origin)return route.fulfill({status:403,body:'External request blocked'});
      if(!url.pathname.startsWith('/api/'))return route.fulfill({path:dir+(url.pathname==='/'?'/index.html':url.pathname)});
      const path=url.pathname.slice(4);let body;try{body=req.postDataJSON()}catch{}
      if(method!=='GET')state.calls.push({path,method,body});
      const send=(json,status=200)=>route.fulfill({json,status});
      if(path==='/phone/status')return state.statusFail?send({error:'Test status unavailable'},503):send(state.status);
      if(path==='/phone/devices')return send({devices:[]});
      if(path==='/phone/apns')return send({configured:false,can_edit:false,transport:true,devices:[]});
      if(path==='/phone/setup'){
        if(state.failSetup)return send({error:'Test consent save failed'},503);
        state.status.setup={required:false,accepted:true,closed_lid_requested:body.closed_lid,allow_battery_requested:body.allow_battery};return send(state.status.setup);
      }
      if(path==='/runtime/tunnel/start'){
        if(state.failTunnel)return send({error:'Test tunnel unavailable'},503);
        state.status.tunnel={...tunnel};state.status.urls=urls.map(x=>({...x}));return send({ok:true,...tunnel});
      }
      if(path==='/phone/availability/start'){
        state.status.availability=state.approved?{state:'active',allow_battery:state.status.setup.allow_battery_requested,battery_floor:20,expires_at:'2026-10-11T23:00:00Z',lease_id:'SHOULD_NEVER_RENDER'}:{state:'needs_approval'};
        return send(state.status.availability);
      }
      if(path==='/phone/availability/approval')return send(state.status.availability);
      if(path==='/phone/availability/stop'){
        state.status.availability={state:state.failStop?'restore_failed':'stopped'};
        return state.failStop?send({error:'Test restore failed'},503):send(state.status.availability);
      }
      if(path==='/phone/pair/start')return send({code:'SETUP42',code_display:'SET UP 42',expires_at:new Date(Date.now()+300000).toISOString(),urls:state.status.urls.map(u=>({...u,pair_url:u.url+'/pair#SETUP42'}))});
      return send({error:'Unexpected fixture operation: '+path},500);
    });
    const p=await context.newPage();p.setDefaultTimeout(8000);p.on('pageerror',e=>errors.push(e.message));await p.goto(origin);await p.locator('[data-phone-setup]').waitFor();return{p,state};
  }
  async function save(p){await p.getByRole('button',{name:'Agree and set up iPhone access',exact:true}).click();await p.getByRole('button',{name:'Review permissions',exact:true}).waitFor();await p.getByText('Saving your choices and connecting this Mac…',{exact:true}).waitFor({state:'hidden'});}
  const control=p=>p.getByRole('checkbox',{name:/Allow my paired phone to control IVE/});
  const lid=p=>p.getByRole('checkbox',{name:/Keep this Mac available with the lid closed/});
  const battery=p=>p.getByRole('checkbox',{name:'Also run on battery (optional)',exact:true});
  try {
    let {p,state}=await fixture({status:{tunnel:{...tunnel},urls:urls.map(x=>({...x}))}});
    assert(!(await control(p).isChecked()),'Full-control consent starts unchecked');
    assert(!(await lid(p).isChecked()),'Closed-lid mode starts as an explicit optional choice');
    assert(await p.getByRole('button',{name:'Agree and set up iPhone access',exact:true}).isDisabled(),'Setup cannot proceed without consent');
    assert(await p.locator('[data-phone-pair-start]').isDisabled(),'Existing tunnel alone cannot bypass consent for QR');
    assert(state.calls.length===0,'Opening setup never changes network or Mac power');
    await lid(p).check();assert(!(await battery(p).isChecked()),'Battery access is a separate unchecked option');
    const initial=dir+'/phone-setup-choices.png';await p.screenshot({path:initial});screenshots.push(initial);
    await lid(p).uncheck();await control(p).check();await save(p);
    assert(state.calls.filter(c=>c.path.includes('/availability/')).length===0,'First-time normal-sleep setup makes no OS power request');
    assert(state.status.setup.accepted&&!state.status.setup.closed_lid_requested,'Only chosen consent options are saved');
    assert(await p.locator('[data-phone-pair-start]').isEnabled(),'Confirmed consent plus actual tunnel enables QR');
    await p.locator('[data-phone-pair-start]').click();await p.locator('[data-phone-pair-code="SETUP42"]').waitFor();
    assert(true,'Fresh code can be requested after consent and connection');

    ({p,state}=await fixture({failSetup:true}));await control(p).check();
    await p.getByRole('button',{name:'Agree and set up iPhone access',exact:true}).click();await p.getByRole('alert').filter({hasText:'Test consent save failed'}).waitFor();
    assert(!state.calls.some(c=>c.path==='/runtime/tunnel/start'),'Failed consent never starts a tunnel');
    assert(await p.locator('[data-phone-pair-start]').isDisabled(),'Failed consent cannot enable QR');

    ({p,state}=await fixture({failTunnel:true}));await control(p).check();await lid(p).check();await battery(p).check();await save(p);
    await p.getByRole('alert').filter({hasText:'Test tunnel unavailable'}).waitFor();
    assert(state.status.setup.accepted&&state.status.setup.closed_lid_requested,'Partial setup retains the actually saved choices');
    assert(!state.calls.some(c=>c.path==='/phone/availability/start'),'Power activation waits for a successful tunnel');
    assert(await p.locator('[data-phone-pair-start]').isDisabled(),'Saved choices without a live tunnel never enable QR');
    assert((await p.locator('[data-phone-setup]').innerText()).includes('does not grant macOS approval'),'Saved preference is explicitly distinct from OS approval');
    state.failTunnel=false;await p.getByRole('button',{name:'Keep Mac available',exact:true}).click();await p.locator('[data-phone-availability="needs_approval"]').waitFor();
    assert(await p.getByRole('button',{name:'Open macOS approval settings',exact:true}).isVisible(),'Missing macOS approval has a concrete settings action');
    await p.getByRole('button',{name:'Open macOS approval settings',exact:true}).click();
    await p.getByRole('button',{name:'Continue after approval',exact:true}).click();await p.getByText('Checking approval and starting availability…',{exact:true}).waitFor({state:'hidden'});await p.locator('[data-phone-availability="needs_approval"]').waitFor();
    assert(await p.locator('[data-phone-availability="active"]').count()===0,'Opening settings or continuing before approval cannot claim active');
    state.approved=true;await p.getByRole('button',{name:'Continue after approval',exact:true}).click();await p.locator('[data-phone-availability="active"]').waitFor();
    let text=await p.locator('[data-phone-setup]').innerText();
    assert(text.includes('Control–Command–Q')&&text.includes('works while the screen is locked'),'Active mode instructs manual locking without claiming automatic screen lock');
    assert(text.includes('maximum 8 hours')&&text.includes('20%')&&text.includes('high temperature')&&text.includes('Closing IVE'),'Active mode explains duration, battery, heat and app-exit limits');
    assert(!text.includes('SHOULD_NEVER_RENDER'),'Internal lease data never appears in UI');
    const active=dir+'/phone-setup-active.png';await p.screenshot({path:active});screenshots.push(active);
    await p.getByRole('button',{name:'Review permissions',exact:true}).click();await battery(p).uncheck();await control(p).check();await save(p);
    const powerCalls=state.calls.filter(c=>c.path.includes('/availability/')).map(c=>c.path);
    assert(powerCalls.at(-2)==='/phone/availability/stop'&&powerCalls.at(-1)==='/phone/availability/start','Changing active battery permission stops the old mode before reactivation');
    assert(state.status.availability.allow_battery===false,'Active mode reflects the newly confirmed battery choice');
    await p.getByRole('button',{name:'Review permissions',exact:true}).click();await battery(p).check();await p.getByRole('button',{name:'Cancel',exact:true}).first().click();await p.getByRole('button',{name:'Review permissions',exact:true}).click();
    assert(!(await battery(p).isChecked())&&!(await control(p).isChecked()),'Review reloads saved choices after Cancel and requires fresh consent');
    await p.getByRole('button',{name:'Cancel',exact:true}).first().click();state.failStop=true;await p.getByRole('button',{name:'Restore normal sleep',exact:true}).click();await p.locator('[data-phone-availability="restore_failed"]').waitFor();
    assert(await p.getByRole('button',{name:'Restore normal sleep',exact:true}).isEnabled(),'Restore failure remains visible with a retry action');
    assert(await p.getByRole('button',{name:'Keep Mac available',exact:true}).count()===0,'Failed restoration never offers a conflicting new start');
    state.failStop=false;await p.getByRole('button',{name:'Restore normal sleep',exact:true}).click();await p.locator('[data-phone-availability="stopped"]').waitFor();assert(true,'Successful retry confirms normal sleep');

    ({p,state}=await fixture({status:{setup:{...accepted},availability:{state:'active',allow_battery:false},tunnel:{...tunnel},urls:urls.map(x=>({...x}))}}));
    await p.locator('[data-phone-pair-start]').click();await p.locator('[data-phone-pair-code]').waitFor();state.statusFail=true;
    await p.getByRole('button',{name:'Check availability',exact:true}).click();await p.locator('[data-phone-availability="unknown"]').waitFor();
    assert(await p.locator('[data-phone-pair-code]').count()===0&&await p.locator('[data-phone-pair-start]').isDisabled(),'Status failure removes stale QR and disables new pairing');
    assert(await p.locator('[data-phone-availability="active"]').count()===0,'Unverified status cannot leave a false active indicator');
    assert(await p.getByRole('button',{name:'Keep Mac available',exact:true}).count()===0&&await p.locator('[data-phone-tunnel-start]').count()===0,'Unknown status requires checking before another start');
    assert(await p.getByText('Connection status could not be checked',{exact:true}).isVisible(),'Unknown connection is not misrepresented as a confirmed disconnection');
    const unknown=dir+'/phone-setup-unverified.png';await p.screenshot({path:unknown});screenshots.push(unknown);
    assert(errors.length===0,'No JavaScript page errors');
    return{kind:'Isolated PhonePanel/PhoneSetup UI with stubbed network/helper APIs; no real OS power or iPhone test',passed:checks.length,checks,errors,screenshots};
  } finally {await Promise.all(contexts.map(c=>c.close()))}
}
