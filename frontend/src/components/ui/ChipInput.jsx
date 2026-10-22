import { useState } from 'react'
import { X } from 'lucide-react'
import Chip from './Chip'

export default function ChipInput({ values, onChange, placeholder = 'Add value…' }) {
  const [draft, setDraft] = useState('')
  const items = Array.isArray(values) ? values : []

  const addDraft = () => {
    const additions = draft.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
    if (!additions.length) return
    onChange([...new Set([...items, ...additions])])
    setDraft('')
  }

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-x-line bg-x-surface-2 px-2 py-1.5 focus-within:ring-1 focus-within:ring-x-accent/50">
      {items.map((item) => (
        <Chip key={item} color="accent" className="rounded-full">
          {item}
          <button type="button" aria-label={`Remove ${item}`} onClick={() => onChange(items.filter((value) => value !== item))} className="text-x-faint hover:text-x-ink">
            <X size={9} />
          </button>
        </Chip>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={addDraft}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault()
            addDraft()
          } else if (event.key === 'Backspace' && !draft && items.length) {
            onChange(items.slice(0, -1))
          }
        }}
        placeholder={items.length ? '' : placeholder}
        className="min-w-[140px] flex-1 bg-transparent text-xs text-x-ink placeholder-x-faint outline-none"
      />
    </div>
  )
}
