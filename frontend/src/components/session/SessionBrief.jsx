import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, RefreshCw, ArrowUpRight, FileDiff, Play, MessageCircle } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { briefEvidence, plainExcerpt, relativeActivity } from '../../lib/sessionBrief'
import { getSessionDisplayStatus } from '../../lib/sessionStatus'
const EMPTY = []
export default function SessionBrief({ sessionId, onOpenReview, onOpenPanel }) {
  const session = useStore(s => s.sessions[sessionId])
  const messages = useStore(s => s.messages[sessionId] || EMPTY)
  const started = useStore(s => s.sessionStarted)
  const pending = useStore(s => s.awaitingReplies?.[sessionId])
  const [open,setOpen] = useState(false), [data,setData] = useState(null), [refresh,setRefresh] = useState(0)
  const [loading,setLoading] = useState(false)
  const evidence = useMemo(() => briefEvidence(messages),[messages])
  const status = getSessionDisplayStatus(session, started)
  useEffect(() => { setOpen(false);setData(null) },[sessionId])
  useEffect(() => {
    if (!sessionId || !session?.workspace_id || !open) return
    let disposed=false
    setLoading(true)
    Promise.allSettled([api.getSessionDigest(sessionId), api.getGitStatus(session.workspace_id)]).then(([digest,git]) => {
      if (disposed) return
      setData({digest:digest.status==='fulfilled'?digest.value:null,git:git.status==='fulfilled'?git.value:null,
        error:git.status==='rejected'||git.value?.error? 'Project changes could not be loaded. Try refreshing.':null})
      setLoading(false)
    })
    return () => { disposed=true }
  },[sessionId,session?.workspace_id,status.state,open,refresh])
  if (!session) return null
  const label = pending ? 'Waiting for a response' : status.state==='waiting' ? 'Your answer is needed' : status.state==='running' ? 'Working on your request' : status.state==='failed' ? 'Needs attention' : status.state==='stopped' ? 'Session stopped' : evidence.latest ? 'Reply ready' : 'Ready for your task'
  const latest = plainExcerpt(evidence.latest?.content || evidence.lastUser?.content || session.summary)
  const files = [...new Set([...(data?.git?.staged || []),...(data?.git?.unstaged || []),...(data?.git?.untracked || [])].map(f=>typeof f==='string'?f:f.path).filter(Boolean))]
  const touched = Array.isArray(data?.digest?.files_touched) ? data.digest.files_touched.map(f=>typeof f==='string'?f:f.path || f.file).filter(Boolean):[]
  const jump = id => window.dispatchEvent(new CustomEvent('ive-reveal-message',{detail:{sessionId,messageId:id}}))
  const answer = () => { const el=document.querySelector(`[data-session-view="${sessionId}"] [data-session-prompt-actions]`);el?.scrollIntoView({block:'nearest'});el?.querySelector('button:not(:disabled),input:not(:disabled)')?.focus() }
  return <section className="ive-session-brief" aria-label="Session overview" data-session-brief>
    <div className="ive-session-brief-line">
      <button type="button" className="ive-brief-toggle" aria-expanded={open} onClick={()=>setOpen(!open)}>
        <span className={`ive-brief-dot is-${status.state}`} /><strong>{label}</strong><ChevronDown size={14} style={{transform:open?'rotate(180deg)':undefined}} />
      </button>
      <span className="ive-brief-last" title={latest}>{latest || 'Describe what you want to work on below.'}</span>
      {status.state==='waiting' && <button className="ive-brief-link" onClick={answer}>Review request <ArrowUpRight size={13}/></button>}
    </div>
    {open && <div className="ive-brief-body">
      <div className="ive-brief-columns">
        <div><h3>Where things stand</h3><p>{latest || 'No assistant reply yet.'}</p>
          <p className="ive-brief-muted">{status.state==='waiting'?'Review the assistant’s question below to continue.':status.state==='running'||pending?'You can write your next message while the assistant works.':status.state==='failed'?'Review the error in the conversation before trying again.':status.state==='stopped'?'The conversation is saved. Use the session controls to resume.':evidence.latest?'Review the reply, then continue with a follow-up.':'Describe your task below to start this session.'}</p>
          {evidence.latest && <button className="ive-brief-link" onClick={()=>jump(evidence.latest.id)}>Read latest reply <ArrowUpRight size={13}/></button>}
        </div>
        <div><h3>Changes & results</h3><p className="ive-brief-muted">{loading?'Loading project changes…':data?.error || (data?.git?.is_git_repo === false ? 'This folder is not a Git repository. Change tracking is unavailable.' : `${files.length} uncommitted project ${files.length===1?'file':'files'}. Includes work from other sessions.`)}</p>
          {files.slice(0,5).map(file=><button key={file} className="ive-brief-file" onClick={()=>onOpenReview?.(file)}><FileDiff size={12}/><span>{file}</span></button>)}
          {touched.length>0 && <p className="ive-brief-muted">Session notes mention {touched.length} {touched.length===1?'file':'files'}.</p>}
          <div className="ive-brief-actions"><button className="ive-brief-link" onClick={()=>onOpenReview?.()}>Review changes</button><button className="ive-brief-link" onClick={()=>onOpenPanel?.('preview')}><Play size={12}/>Open preview</button></div>
        </div>
        <div><h3>Checks & shared context</h3>
          {!evidence.checks.length && <p className="ive-brief-muted">No test-command results recorded in the loaded part of this turn.</p>}
          {evidence.checks.map((check,i)=><button key={`${check.id}-${i}`} className="ive-brief-evidence" onClick={()=>jump(check.id)}><span>{check.label}</span><small>{check.detail}</small></button>)}
          {evidence.collaboration.map((event,i)=><button key={`${event.id}-${i}`} className="ive-brief-link" onClick={()=>jump(event.id)}><MessageCircle size={12}/>{event.label}</button>)}
        </div>
      </div>
      <div className="ive-brief-footer"><span>From the conversation and current project state · {relativeActivity(session)}</span><button aria-label="Refresh session overview" className="ive-brief-link" onClick={()=>setRefresh(n=>n+1)} disabled={loading}><RefreshCw size={12}/>Refresh</button></div>
    </div>}
  </section>
}
