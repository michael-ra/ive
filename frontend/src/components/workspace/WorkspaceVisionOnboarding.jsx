import { useState } from 'react'
import { Telescope, X } from 'lucide-react'
import { api } from '../../lib/api'

const QUESTIONS = [
  {
    key: 'vision',
    label: 'Vision — what is this product?',
    placeholder: 'In 1–2 sentences: what are you building, and what does the finished thing do for someone? Skip the implementation talk.',
    memoryName: 'Product vision',
    memoryDescription: 'One-paragraph product vision captured at workspace creation.',
  },
  {
    key: 'audience',
    label: 'Who is it for?',
    placeholder: 'Target users / customers / personas. e.g. "solo founders shipping AI products", "data teams at mid-market SaaS".',
    memoryName: 'Target audience',
    memoryDescription: 'Who the product is built for; informs voice-of-customer extraction.',
  },
  {
    key: 'competitors',
    label: 'Competitors or adjacent tools',
    placeholder: 'Anything you compare yourself to, even loosely. Comma-separated names + a hint of why each is on your radar.',
    memoryName: 'Competitor radar',
    memoryDescription: 'Named competitors and overlapping tools the user has on their radar.',
  },
  {
    key: 'differentiator',
    label: 'What makes it different?',
    placeholder: 'Why does this exist when those already do? What\'s the unfair angle / wedge?',
    memoryName: 'Differentiator',
    memoryDescription: 'How this project differentiates from competitors.',
  },
]

export default function WorkspaceVisionOnboarding({ workspace, onClose, onDone }) {
  const [answers, setAnswers] = useState(() =>
    QUESTIONS.reduce((m, q) => ({ ...m, [q.key]: '' }), {})
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const setAnswer = (key, value) =>
    setAnswers((prev) => ({ ...prev, [key]: value }))

  const handleSkip = () => {
    onClose?.()
  }

  const handleSave = async () => {
    if (!workspace?.id) {
      onClose?.()
      return
    }
    setSaving(true)
    setError(null)
    try {
      const writes = QUESTIONS
        .filter((q) => (answers[q.key] || '').trim())
        .map((q) =>
          api.createMemoryEntry({
            type: 'project',
            name: q.memoryName,
            description: q.memoryDescription,
            content: answers[q.key].trim(),
            workspace_id: workspace.id,
            source_cli: 'commander',
            tags: ['onboarding', 'vision'],
          })
        )
      await Promise.all(writes)
      onDone?.(workspace)
      onClose?.()
    } catch (e) {
      setError(e?.message || 'Failed to save answers')
    } finally {
      setSaving(false)
    }
  }

  const wsLabel = workspace?.name || 'this workspace'

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-950 z-10">
          <div className="flex items-center gap-2">
            <Telescope size={16} className="text-indigo-400" />
            <div>
              <h2 className="text-zinc-100 text-sm font-semibold">Set the vision for {wsLabel}</h2>
              <p className="text-zinc-500 text-[11px] mt-0.5">
                Stored as project memory. Drives the Observatory profile and downstream agents — skip any question that doesn't apply.
              </p>
            </div>
          </div>
          <button onClick={handleSkip} className="text-zinc-500 hover:text-zinc-300">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {QUESTIONS.map((q) => (
            <label key={q.key} className="block">
              <span className="text-zinc-300 text-[12px] font-medium">{q.label}</span>
              <textarea
                value={answers[q.key]}
                onChange={(e) => setAnswer(q.key, e.target.value)}
                placeholder={q.placeholder}
                rows={3}
                className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded text-zinc-100 text-[12px] p-2 font-mono resize-y focus:outline-none focus:border-indigo-600"
              />
            </label>
          ))}

          {error && (
            <div className="text-rose-400 text-[11px] font-mono">{error}</div>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
            <button
              onClick={handleSkip}
              disabled={saving}
              className="text-[11px] text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
            >
              Skip — fill in later via Smart Observatory
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 text-[12px] bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded transition-colors"
            >
              {saving ? 'Saving…' : 'Save vision'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
