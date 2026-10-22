"""Isolated sweep validation, bounded concurrency, and cancellation regressions."""
import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import db as database
import sweep_engine as sweep
import llm_router

class SweepAuditTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        for name,value in [('DATA_DIR',Path(self.tmp.name)),('DB_PATH',Path(self.tmp.name)/'state.db')]:
            p=patch.object(database,name,value);p.start();self.addCleanup(p.stop)
        await database.init_db()
        self.db=await database.get_db();self.addAsyncCleanup(self.db.close)
        await self.db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','Sweep fixture',?)",(self.tmp.name,));await self.db.commit()
        p=patch.object(llm_router,'resolve_model',AsyncMock(return_value={}));p.start();self.addCleanup(p.stop)

    async def test_validation_returns_errors_before_provider_use(self):
        for prompts,options in [('text',{}),(['x'],{'parallel':'invalid'}),(['x'],{'synthesis_prompt':42})]:
            result=await sweep.run_sweep('ws',prompts,**options)
            self.assertIn('error',result)
        request=SimpleNamespace(json=AsyncMock(return_value=[]),headers={})
        self.assertEqual((await sweep.handle_run_sweep(request)).status,400)

    async def test_bounded_parallelism_preserves_order_and_partial_results(self):
        active=peak=0
        async def call(model,prompt,**kwargs):
            nonlocal active,peak
            active+=1;peak=max(peak,active)
            try:
                await asyncio.sleep(.01)
                if prompt=='bad':raise RuntimeError('provider failure')
                return {'text':f'answer {prompt}'}
            finally:active-=1
        with patch.object(llm_router,'call_json',call):
            result=await sweep.run_sweep('ws',['a','bad','c'],parallel=2,synthesize=False)
        self.assertEqual(peak,2)
        self.assertEqual(result['agents_done'],2)
        self.assertEqual([r['ok'] for r in result['results']],[True,False,True])
        row=await (await self.db.execute('SELECT * FROM workflow_runs WHERE id=?',(result['run_id'],))).fetchone()
        self.assertEqual(row['status'],'completed');self.assertIn('answer c',row['result'])

    async def test_cancel_marks_provenance_cancelled(self):
        started=asyncio.Event()
        async def call(*args,**kwargs):started.set();await asyncio.Event().wait()
        with patch.object(llm_router,'call_json',call):
            task=asyncio.create_task(sweep.run_sweep('ws',['a']))
            await started.wait();task.cancel()
            with self.assertRaises(asyncio.CancelledError):await task
        row=await (await self.db.execute('SELECT status FROM workflow_runs')).fetchone()
        self.assertEqual(row['status'],'cancelled')

if __name__=='__main__':unittest.main()
