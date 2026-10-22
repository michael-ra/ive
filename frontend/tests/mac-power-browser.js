// Run through the Playwright plugin after node tests/mac-power-fixture.mjs.
async (page) => {
  const browser = page.context().browser(), contexts = [], checks = [], errors = [], screenshots = [];
  const origin = 'http://ive-mac-power.test', dir = '/tmp/ive-mac-power-ui';
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  async function fixture(initial = {}) {
    const s = { calls: [], approved: false, statusFail: false, stopFail: false, startFail: false,
      status: { state: 'not_registered', lid_saver_supported: true, battery_floor: 20 }, ...initial };
    const context = await browser.newContext({ viewport: { width: 1000, height: 960 }, reducedMotion: 'reduce', serviceWorkers: 'block' }); contexts.push(context);
    await context.route('**/*', async route => {
      const r = route.request(), url = new URL(r.url());
      if (url.origin !== origin) return route.fulfill({ status: 403, body: 'External requests blocked' });
      if (!url.pathname.startsWith('/api/')) return route.fulfill({ path: dir + (url.pathname === '/' ? '/index.html' : url.pathname) });
      if (r.method() === 'GET') return s.statusFail ? route.fulfill({ status: 503, json: { error: 'Test status unavailable' } }) : route.fulfill({ json: s.status });
      const action = url.pathname.split('/').at(-1), body = r.postData() ? r.postDataJSON() : null;
      s.calls.push({ action, body });
      if (action === 'start') {
        if (s.startFail) return route.fulfill({ status: 503, json: { error: 'Test start uncertain' } });
        s.status = s.approved ? { state: 'active', mode_source: 'agent', lid_saver_supported: true, ...body,
          lid_closed: false, lid_saver_active: false, low_power_active: false, paused_processes: 0,
          expires_at: new Date(Date.now() + body.duration_seconds * 1000).toISOString(), battery_percent: 76, on_battery: true }
          : { state: 'needs_approval', lid_saver_supported: true };
      }
      if (action === 'stop') s.status = { state: s.stopFail ? 'restore_failed' : 'ready', lid_saver_supported: true };
      return route.fulfill({ json: s.status });
    });
    const p = await context.newPage(); p.setDefaultTimeout(8000); p.on('pageerror', e => errors.push(e.message));
    await p.goto(origin); await p.locator('[data-mac-power-state]').filter({ hasNotText: 'Status wird geprüft' }).waitFor();
    return { p, s };
  }
  const status = (p, phase) => p.locator(`[data-mac-power-state="${phase}"]`).waitFor();
  const refresh = p => p.getByRole('button', { name: 'Status prüfen', exact: true }).click();
  try {
    let { p, s } = await fixture();
    await status(p, 'not_registered');
    check(s.calls.length === 0, 'Opening settings never registers a helper or changes power');
    check(await p.getByRole('checkbox', { name: /macOS-Stromsparmodus/ }).isChecked(), 'Lid saver is offered as a visible option');
    check(!(await p.getByRole('checkbox', { name: /Auch im Akkubetrieb/ }).isChecked()), 'Battery operation remains explicit');
    for (const name of ['Slack', 'Discord', 'WhatsApp', 'Spotify']) check(!(await p.getByRole('checkbox', { name, exact: true }).isChecked()), name + ' starts unselected');
    await p.getByRole('checkbox', { name: /Auch im Akkubetrieb/ }).check();
    await p.getByRole('checkbox', { name: 'Discord', exact: true }).check();
    await p.getByLabel('Maximale Laufzeit').selectOption('1800');
    check(s.calls.length === 0, 'Selecting lid actions alone causes no OS changes');
    const optionsShot = dir + '/mac-power-options.png'; await p.screenshot({ path: optionsShot, fullPage: true }); screenshots.push(optionsShot);
    await p.getByRole('button', { name: 'Funktion einschalten', exact: true }).click(); await status(p, 'needs_approval');
    check(s.calls[0].body.duration_seconds === 1800 && s.calls[0].body.allow_battery === true && s.calls[0].body.lid_low_power === true && JSON.stringify(s.calls[0].body.pause_apps) === '["com.hnc.Discord"]', 'Only selected settings reach start');
    check(await p.getByRole('button', { name: 'macOS-Freigabe öffnen', exact: true }).isVisible(), 'Missing approval has a direct next action');
    await p.getByRole('button', { name: 'macOS-Freigabe öffnen', exact: true }).click();
    check(s.status.state === 'needs_approval', 'Opening approval settings does not imply activation');
    s.approved = true; await p.getByRole('button', { name: 'Nach Freigabe einschalten', exact: true }).click(); await status(p, 'active');
    check((await p.getByRole('status').innerText()).includes('bereit zum Zuklappen'), 'Open lid is armed, not falsely saving');
    check(await p.getByText('Keine Apps pausiert', { exact: true }).isVisible(), 'Open lid reports no paused apps');
    check(await p.getByRole('checkbox', { name: 'Discord', exact: true }).isDisabled(), 'Active options cannot be silently changed');
    check((await p.getByLabel('Verbleibende Laufzeit').innerText()).startsWith('00:29:') || (await p.getByLabel('Verbleibende Laufzeit').innerText()) === '00:30:00', 'Countdown uses confirmed expiry');
    Object.assign(s.status, { lid_closed: true, lid_saver_active: true, low_power_active: true, paused_processes: 3 }); await refresh(p);
    await p.getByText('Sparmodus läuft · Deckel geschlossen', { exact: true }).waitFor();
    check(await p.getByText('Ausgewählte Apps pausiert', { exact: true }).isVisible(), 'Closed lid reports verified saver and app suspension');
    const activeShot = dir + '/mac-power-closed.png'; await p.screenshot({ path: activeShot, fullPage: true }); screenshots.push(activeShot);
    Object.assign(s.status, { lid_closed: false, lid_saver_active: false, low_power_active: false, paused_processes: 0 }); await refresh(p);
    await p.getByText('Eingeschaltet · bereit zum Zuklappen', { exact: true }).waitFor();
    check(await p.getByText('Keine Apps pausiert', { exact: true }).isVisible(), 'Reopening restores apps while the feature stays armed');
    s.stopFail = true; await p.getByRole('button', { name: 'Ausschalten und wiederherstellen', exact: true }).click(); await status(p, 'restore_failed');
    check(await p.getByRole('button', { name: 'Ausschalten und wiederherstellen', exact: true }).isEnabled(), 'Restore failure offers retry');
    check(await p.getByRole('button', { name: 'Funktion einschalten', exact: true }).count() === 0, 'No new start during failed restoration');
    s.stopFail = false; await p.getByRole('button', { name: 'Ausschalten und wiederherstellen', exact: true }).click(); await status(p, 'ready');
    check(true, 'Explicit stop confirms restoration');
    s.startFail = true; await p.getByRole('button', { name: 'Funktion einschalten', exact: true }).click(); await status(p, 'unknown');
    check(await p.getByRole('button', { name: 'Funktion einschalten', exact: true }).isDisabled(), 'Uncertain activation requires fresh status before retry');
    check(await p.getByRole('alert').isVisible(), 'Action error remains visible');
    s.statusFail = true; await refresh(p); await p.getByRole('alert').filter({ hasText: 'Test status unavailable' }).waitFor();
    check(await p.locator('[data-mac-power-state="active"]').count() === 0, 'Lost verification never leaves an active claim');
    ({ p, s } = await fixture({ status: { state: 'unavailable' } })); await status(p, 'unavailable');
    check(await p.getByRole('button', { name: 'Funktion einschalten', exact: true }).isDisabled() && s.calls.length === 0, 'Browser-only installation cannot activate privileged actions');
    ({ p, s } = await fixture({ status: { state: 'ready', lid_saver_supported: false } })); await status(p, 'ready');
    check(await p.getByRole('button', { name: 'Funktion einschalten', exact: true }).isDisabled(), 'Older native helper cannot masquerade as supporting lid actions');
    await p.setViewportSize({ width: 390, height: 844 });
    check(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Panel fits narrow screens without horizontal overflow');
    const mobileShot = dir + '/mac-power-narrow.png'; await p.screenshot({ path: mobileShot, fullPage: true }); screenshots.push(mobileShot);
    check(errors.length === 0, 'No JavaScript page errors');
    return { passed: checks.length, checks, screenshots, evidence: 'Isolated UI fixtures. No native registration, power changes or real app pauses.' };
  } finally { await Promise.all(contexts.map(c => c.close())); }
}
