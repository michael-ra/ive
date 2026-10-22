import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Zap, X, Mic, MicOff, Paperclip, UploadCloud } from 'lucide-react'
import { api } from '../../lib/api'
import { useVoiceInput } from '../../hooks/useVoiceInput'
import useStore from '../../state/store'
import ImageAnnotator from '../chat/ImageAnnotator'
import { Button } from '../ui'

const PRIORITIES = ['normal', 'high', 'critical']
const PRIORITY_KEYS = { '1': 'normal', '2': 'high', '3': 'critical' }

export default function QuickFeatureModal({ prefillText, initialPastedImages = [], autoVoice, workspaceId: preferredWorkspaceId, onCreated, onClose }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState(prefillText || '')
  const [priority, setPriority] = useState('normal')
  const [creating, setCreating] = useState(false)
  const [duplicates, setDuplicates] = useState(null)
  const [pastedImages, setPastedImages] = useState(initialPastedImages || [])
  const [annotatingImage, setAnnotatingImage] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const titleRef = useRef(null)
  const descriptionRef = useRef(null)
  const fileInputRef = useRef(null)
  const voiceStarted = useRef(false)

  // Autocomplete states
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const [autocompleteIndex, setAutocompleteIndex] = useState(0)
  const [autocompleteType, setAutocompleteType] = useState(null) // 'ticket' | 'at'
  const [autocompleteQuery, setAutocompleteQuery] = useState('')
  const [autocompleteTarget, setAutocompleteTarget] = useState(null) // 'title' | 'description'

  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  const tasks = useStore((s) => s.tasks)
  const workspaceId = preferredWorkspaceId || activeWorkspaceId || workspaces[0]?.id

  const workspaceTasks = useMemo(() => {
    if (!workspaceId) return []
    return Object.values(tasks).filter(
      (t) => t.workspace_id === workspaceId && t.status !== 'archived'
    )
  }, [tasks, workspaceId])

  const autocompleteItems = useMemo(() => {
    if (autocompleteType === 'at') {
      return [
        {
          key: '@ticket:',
          label: '@ticket:',
          desc: 'Mention a ticket/task',
          value: '@ticket:',
          type: 'at_option',
        }
      ]
    }
    if (autocompleteType === 'ticket') {
      const query = autocompleteQuery.toLowerCase()
      const statusWeight = { in_progress: 0, todo: 1, backlog: 2, completed: 3 }
      const sortedTasks = [...workspaceTasks].sort((a, b) => {
        const wa = statusWeight[a.status] ?? 99
        const wb = statusWeight[b.status] ?? 99
        if (wa !== wb) return wa - wb
        return new Date(b.created_at || 0) - new Date(a.created_at || 0)
      })

      const filtered = query
        ? sortedTasks.filter(
            (t) =>
              t.title?.toLowerCase().includes(query) ||
              t.id?.toLowerCase().includes(query) ||
              t.description?.toLowerCase().includes(query)
          )
        : sortedTasks

      return filtered.slice(0, 8).map((t) => ({
        key: t.id,
        label: `#${t.id.slice(0, 8)}`,
        title: t.title,
        status: t.status,
        value: t,
        type: 'ticket',
      }))
    }
    return []
  }, [autocompleteType, autocompleteQuery, workspaceTasks])

  const getAutocompleteToken = (value, caret) => {
    const before = value.slice(0, caret)

    // Check for @ticket:"some query...
    const ticketQuoteMatch = before.match(/(^|[\s\n])@ticket:"([^"]*)$/)
    if (ticketQuoteMatch) {
      const token = ticketQuoteMatch[0].trimStart()
      return {
        type: 'ticket',
        token,
        query: ticketQuoteMatch[2],
        start: caret - token.length,
        end: caret,
      }
    }

    // Check for @ticket:some_query or @ticket:
    const ticketMatch = before.match(/(^|[\s\n])@ticket:([^\s\n]*)$/)
    if (ticketMatch) {
      const token = ticketMatch[0].trimStart()
      return {
        type: 'ticket',
        token,
        query: ticketMatch[2],
        start: caret - token.length,
        end: caret,
      }
    }

    // Check for just @ticket
    const ticketBaseMatch = before.match(/(^|[\s\n])@ticket$/)
    if (ticketBaseMatch) {
      const token = ticketBaseMatch[0].trimStart()
      return {
        type: 'ticket',
        token,
        query: '',
        start: caret - token.length,
        end: caret,
      }
    }

    // Check for just @
    const atMatch = before.match(/(^|[\s\n])@$/)
    if (atMatch) {
      const token = atMatch[0].trimStart()
      return {
        type: 'at',
        token,
        query: '',
        start: caret - token.length,
        end: caret,
      }
    }

    return null
  }

  const updateAutocomplete = useCallback((value, caret, target) => {
    const token = getAutocompleteToken(value, caret)
    if (!token) {
      setShowAutocomplete(false)
      setAutocompleteType(null)
      setAutocompleteQuery('')
      setAutocompleteIndex(0)
      setAutocompleteTarget(null)
      return
    }

    let hasItems = false
    if (token.type === 'at') {
      hasItems = true
    } else if (token.type === 'ticket') {
      hasItems = workspaceTasks.length > 0
    }

    setAutocompleteType(token.type)
    setAutocompleteQuery(token.query || '')
    setShowAutocomplete(hasItems)
    setAutocompleteIndex(0)
    setAutocompleteTarget(target)
  }, [workspaceTasks])

  const applyAutocompleteItem = useCallback((item) => {
    if (!autocompleteTarget) return

    const value = autocompleteTarget === 'title' ? title : description
    const setValue = autocompleteTarget === 'title' ? setTitle : setDescription
    const ta = autocompleteTarget === 'title' ? titleRef.current : descriptionRef.current
    const caret = ta?.selectionStart ?? value.length
    const token = getAutocompleteToken(value, caret)
    if (!token) return

    const start = token.start
    const end = token.end

    let replacement = ''
    if (item.type === 'at_option') {
      replacement = `@ticket:`
    } else if (item.type === 'ticket') {
      const task = item.value
      const tTitle = task.title || ''
      if (tTitle.includes(' ') || tTitle.includes('"') || tTitle.includes(':') || tTitle.includes('\'')) {
        replacement = `@ticket:"${tTitle.replace(/"/g, '\\"')}" `
      } else {
        replacement = `@ticket:${tTitle} `
      }
    }

    const nextValue = `${value.slice(0, start)}${replacement}${value.slice(end)}`
    const nextCaret = start + replacement.length

    setValue(nextValue)
    setShowAutocomplete(false)
    setAutocompleteType(null)
    setAutocompleteQuery('')
    setAutocompleteTarget(null)

    requestAnimationFrame(() => {
      if (!ta) return
      ta.focus()
      ta.selectionStart = ta.selectionEnd = nextCaret
    })
  }, [autocompleteTarget, title, description])

  useEffect(() => {
    if (autocompleteIndex >= autocompleteItems.length) {
      setAutocompleteIndex(0)
    }
  }, [autocompleteIndex, autocompleteItems.length])

  const { listening, toggle: toggleVoice } = useVoiceInput(useCallback((text) => {
    if (!titleRef.current?.value?.trim()) {
      setTitle(text)
    } else {
      setDescription((prev) => prev + (prev ? ' ' : '') + text)
    }
  }, []))

  // Auto-start voice if requested
  useEffect(() => {
    if (autoVoice && !voiceStarted.current) {
      voiceStarted.current = true
      const t = setTimeout(toggleVoice, 150)
      return () => clearTimeout(t)
    }
  }, [autoVoice, toggleVoice])

  // Focus title on mount (skip if auto-voice)
  useEffect(() => {
    if (!autoVoice && titleRef.current) titleRef.current.focus()
  }, [autoVoice])

  const handleUploadImage = async (file) => {
    try {
      const formData = new FormData()
      formData.append('file', file, file.name)
      const res = await fetch('/api/paste-image', { method: 'POST', body: formData })
      if (!res.ok) throw new Error('Upload error')
      const data = await res.json()

      const newEntry = {
        url: data.url,
        path: data.path,
        filename: data.filename,
        previewUrl: URL.createObjectURL(file),
      }
      setPastedImages((prev) => [...prev, newEntry])
    } catch (err) {
      console.error('Failed to upload image:', err)
    }
  }

  const handlePaste = async (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) {
          await handleUploadImage(file)
        }
      }
    }
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const files = e.dataTransfer?.files
    if (files && files.length > 0) {
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          await handleUploadImage(file)
        }
      }
    }
  }

  const handleFileChange = async (e) => {
    const files = e.target.files
    if (files && files.length > 0) {
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          await handleUploadImage(file)
        }
      }
    }
    e.target.value = ''
  }

  const removePastedImage = (idx) => {
    setPastedImages((prev) => {
      const img = prev[idx]
      if (img.previewUrl) URL.revokeObjectURL(img.previewUrl)
      return prev.filter((_, i) => i !== idx)
    })
  }

  const handleAnnotationSave = async (blob) => {
    try {
      const formData = new FormData()
      formData.append('file', blob, 'annotated.png')
      const res = await fetch('/api/paste-image', { method: 'POST', body: formData })
      if (!res.ok) throw new Error('Upload error')
      const data = await res.json()

      const idx = annotatingImage?.index
      const newEntry = {
        url: data.url,
        path: data.path,
        filename: data.filename,
        previewUrl: URL.createObjectURL(blob),
      }

      setPastedImages((prev) => {
        if (idx !== null && idx >= 0 && idx < prev.length) {
          const old = prev[idx]
          if (old.previewUrl) URL.revokeObjectURL(old.previewUrl)
          return prev.map((img, i) => (i === idx ? newEntry : img))
        }
        return [...prev, newEntry]
      })
    } catch (err) {
      console.error('Failed to save annotated image:', err)
    }
    setAnnotatingImage(null)
  }

  useEffect(() => {
    return () => {
      pastedImages.forEach((img) => {
        if (img.previewUrl) URL.revokeObjectURL(img.previewUrl)
      })
    }
  }, [pastedImages])

  const handleCreate = useCallback(async (opts = {}) => {
    if (!title.trim() || !workspaceId) return
    setCreating(true)
    try {
      const descSections = []
      if (description.trim()) descSections.push(description.trim())
      if (pastedImages.length > 0) {
        const imageMarkdown = pastedImages
          .map((img) => `![${img.filename}](${img.path})`)
          .join('\n\n')
        descSections.push(imageMarkdown)
      }
      const fullDescription = descSections.join('\n\n')

      const task = await api.createTask({
        workspace_id: workspaceId,
        title: title.trim(),
        description: fullDescription || undefined,
        priority,
        ...(opts.force && { force: true }),
      })
      setDuplicates(null)
      if (listening) toggleVoice()
      onCreated?.(task)
      onClose()
    } catch (err) {
      if (err?.status === 409 && err.body?.candidates) {
        setDuplicates(err.body.candidates)
      } else {
        console.error('Failed to create feature:', err)
      }
      setCreating(false)
    }
  }, [title, description, priority, workspaceId, listening, toggleVoice, onCreated, onClose, pastedImages])

  // Keyboard events
  useEffect(() => {
    const handler = (e) => {
      const meta = e.metaKey || e.ctrlKey

      if (meta && e.key === 'Enter') {
        e.preventDefault()
        handleCreate()
        return
      }

      if (meta && e.key === 'v' && !e.shiftKey) {
        const tag = document.activeElement?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault()
          toggleVoice()
        }
        return
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [handleCreate, toggleVoice])

  const ws = workspaces.find((w) => w.id === workspaceId)

  const inputClass = 'w-full px-3 py-2 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms]'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-3 pt-4 sm:pt-[18vh] bg-x-scrim backdrop-blur-[4px] animate-in" onClick={onClose}>
      <div
        className="w-[min(480px,calc(100vw-1.5rem))] max-h-[calc(100dvh-2rem)] x-panel shadow-x-3 overflow-hidden scale-in flex flex-col relative"
        onClick={(e) => e.stopPropagation()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div className="absolute inset-0 bg-x-bg/95 z-40 flex flex-col items-center justify-center border-2 border-dashed border-x-accent/40 m-2.5 rounded-xl scale-in pointer-events-none shadow-x-1">
            <UploadCloud size={32} className="text-x-accent animate-bounce mb-2" />
            <span className="text-[13px] text-x-accent font-medium">Drop images to attach</span>
            <span className="text-[11px] text-x-muted mt-1">Files will be uploaded automatically</span>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-x-line bg-x-surface-2/10 shrink-0">
          <Zap size={12} className="text-x-accent-ink animate-pulse" />
          <span className="text-[13px] text-x-ink font-semibold">Quick Feature</span>
          {ws && (
            <span className="text-[11px] text-x-muted ml-1.5">
              → {ws.name}
            </span>
          )}
          <div className="flex-1" />

          {/* Voice toggle */}
          <Button type="submit"
            onClick={toggleVoice}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium border transition-colors duration-[80ms] ease-x ${
              listening
                ? 'x-mic-listening'
                : 'bg-transparent border-x-line text-x-muted hover:text-x-ink-secondary hover:bg-x-hover'
            }`}
            title="Toggle voice input (⌘V when not in a text field)"
          >
            {listening ? <MicOff size={10} /> : <Mic size={10} />}
            {listening ? 'stop' : 'voice'}
          </Button>

          <Button type="submit" onClick={onClose} className="p-1 hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]" title="Close">
            <X size={14} />
          </Button>
        </div>

        {/* Voice indicator */}
        {listening && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-x-accent/10 border-b border-x-accent/20 animate-in">
            <Mic size={11} className="text-x-accent animate-pulse" />
            <span className="text-[11px] font-medium text-x-accent">
              dictating... speak clearly to add content
            </span>
          </div>
        )}

        {/* Form */}
        <div className="p-3 space-y-3 overflow-y-auto flex-1 min-h-0">
          <div>
            <label className="text-xs font-medium text-x-ink-secondary mb-1.5 block">Title</label>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => {
                const val = e.target.value
                setTitle(val)
                updateAutocomplete(val, e.target.selectionStart, 'title')
              }}
              onSelect={(e) => updateAutocomplete(e.target.value, e.target.selectionStart, 'title')}
              placeholder="Feature title — what should it do?"
              className={inputClass}
              onKeyDown={(e) => {
                if (showAutocomplete && autocompleteTarget === 'title' && autocompleteItems.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setAutocompleteIndex((i) => (i + 1) % autocompleteItems.length)
                    return
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setAutocompleteIndex((i) => (i - 1 + autocompleteItems.length) % autocompleteItems.length)
                    return
                  } else if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault()
                    applyAutocompleteItem(autocompleteItems[autocompleteIndex])
                    return
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setShowAutocomplete(false)
                    return
                  }
                }
                if (e.altKey && PRIORITY_KEYS[e.key]) {
                  e.preventDefault()
                  setPriority(PRIORITY_KEYS[e.key])
                }
              }}
            />
          </div>

          {showAutocomplete && autocompleteTarget === 'title' && autocompleteItems.length > 0 && (
            <div className="bg-x-surface border border-x-line rounded-lg shadow-x-1 overflow-hidden max-h-40 overflow-y-auto z-50">
              {autocompleteItems.map((item, idx) => (
                <div
                  key={item.key}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    applyAutocompleteItem(item)
                  }}
                  className={`px-3 py-1.5 text-[12px] cursor-pointer flex justify-between items-center transition-colors duration-[80ms] ${
                    idx === autocompleteIndex
                      ? 'bg-x-tint text-x-ink'
                      : 'text-x-ink-secondary hover:bg-x-hover hover:text-x-ink'
                  }`}
                >
                  {item.type === 'ticket' ? (
                    <div className="flex items-center gap-1.5 overflow-hidden w-full">
                      <span className="font-mono text-[11px] text-x-accent shrink-0">{item.label}</span>
                      <span className="truncate flex-1 text-x-ink font-medium text-left">{item.title}</span>
                      <span className="shrink-0 text-[11px] px-1 py-0.2 rounded font-medium bg-x-muted/10 text-x-muted border border-x-line">
                        {item.status}
                      </span>
                    </div>
                  ) : (
                    <div className="flex justify-between items-center w-full">
                      <span className="font-mono text-[11px] font-medium text-x-accent">{item.label}</span>
                      <span className="text-x-muted text-[11px]">{item.desc}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-x-ink-secondary mb-1.5 block">Description</label>
            <textarea
              ref={descriptionRef}
              value={description}
              onChange={(e) => {
                const val = e.target.value
                setDescription(val)
                updateAutocomplete(val, e.target.selectionStart, 'description')
              }}
              onSelect={(e) => updateAutocomplete(e.target.value, e.target.selectionStart, 'description')}
              onPaste={handlePaste}
              placeholder="Details, context, requirements... (optional)"
              rows={6}
              className={`${inputClass} resize-none leading-relaxed`}
              onKeyDown={(e) => {
                if (showAutocomplete && autocompleteTarget === 'description' && autocompleteItems.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setAutocompleteIndex((i) => (i + 1) % autocompleteItems.length)
                    return
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setAutocompleteIndex((i) => (i - 1 + autocompleteItems.length) % autocompleteItems.length)
                    return
                  } else if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault()
                    applyAutocompleteItem(autocompleteItems[autocompleteIndex])
                    return
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setShowAutocomplete(false)
                    return
                  }
                }
              }}
            />
          </div>

          {showAutocomplete && autocompleteTarget === 'description' && autocompleteItems.length > 0 && (
            <div className="bg-x-surface border border-x-line rounded-lg shadow-x-1 overflow-hidden max-h-40 overflow-y-auto z-50">
              {autocompleteItems.map((item, idx) => (
                <div
                  key={item.key}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    applyAutocompleteItem(item)
                  }}
                  className={`px-3 py-1.5 text-[12px] cursor-pointer flex justify-between items-center transition-colors duration-[80ms] ${
                    idx === autocompleteIndex
                      ? 'bg-x-tint text-x-ink'
                      : 'text-x-ink-secondary hover:bg-x-hover hover:text-x-ink'
                  }`}
                >
                  {item.type === 'ticket' ? (
                    <div className="flex items-center gap-1.5 overflow-hidden w-full">
                      <span className="font-mono text-[11px] text-x-accent shrink-0">{item.label}</span>
                      <span className="truncate flex-1 text-x-ink font-medium text-left">{item.title}</span>
                      <span className="shrink-0 text-[11px] px-1 py-0.2 rounded font-medium bg-x-muted/10 text-x-muted border border-x-line">
                        {item.status}
                      </span>
                    </div>
                  ) : (
                    <div className="flex justify-between items-center w-full">
                      <span className="font-mono text-[11px] font-medium text-x-accent">{item.label}</span>
                      <span className="text-x-muted text-[11px]">{item.desc}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Pasted image preview strip */}
          {pastedImages.length > 0 && (
            <div className="flex items-center gap-2 p-2 bg-x-surface-2 border border-x-line rounded-lg overflow-x-auto select-none animate-in">
              <span className="text-[11px] font-medium text-x-muted shrink-0 mr-1.5">Attached:</span>
              <div className="flex items-center gap-2">
                {pastedImages.map((img, i) => (
                  <div key={i} className="relative group shrink-0">
                    <img
                      src={img.previewUrl || img.url}
                      className="h-9 w-9 rounded-lg border border-x-line object-cover cursor-pointer hover:border-x-accent/65 transition-colors duration-[80ms]"
                      title="Click to preview & annotate"
                      onClick={() => setAnnotatingImage({ url: img.previewUrl || img.url, index: i })}
                    />
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removePastedImage(i) }}
                      className="absolute -top-1 -right-1 w-4 h-4 bg-x-surface border border-x-line rounded-full flex items-center justify-center hover:bg-x-accent-ink/20 hover:border-x-accent-ink/30 hover:text-x-accent-ink transition-colors duration-[80ms] cursor-pointer"
                    >
                      <X size={8} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {duplicates && duplicates.length > 0 && (
            <div className="bg-x-surface-2 border border-x-line rounded-lg p-3 space-y-2 animate-in">
              <div className="text-xs font-medium text-x-accent-ink">
                Possible duplicate{duplicates.length > 1 ? 's' : ''} already open:
              </div>
              <ul className="space-y-1 pl-1">
                {duplicates.map((c) => (
                  <li key={c.task_id} className="text-[11px] text-x-ink-secondary truncate">
                    • {c.title}
                  </li>
                ))}
              </ul>
              <div className="flex gap-2 pt-1 border-t border-x-line">
                <Button
                  type="button"
                  onClick={() => handleCreate({ force: true })}
                  disabled={creating}
                  className="px-2.5 py-1 text-[11px] bg-x-accent-ink/15 hover:bg-x-accent-ink/25 border border-x-accent-ink/30 disabled:opacity-40 text-x-accent-ink font-medium transition-colors duration-[80ms] ease-x"
                >
                  Create anyway
                </Button>
                <Button
                  type="button"
                  onClick={() => setDuplicates(null)}
                  className="px-2.5 py-1 text-[11px] bg-x-surface border border-x-line hover:bg-x-hover text-x-ink-secondary font-medium transition-colors duration-[80ms] ease-x"
                >
                  Dismiss
                </Button>
              </div>
            </div>
          )}

          {/* Priority + Submit row */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2">
            {/* Hidden File Input */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              accept="image/*"
              multiple
              className="hidden"
            />

            <div className="flex items-center gap-2 shrink-0">
              {/* Paperclip Button */}
              <Button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-7 h-7 flex items-center justify-center text-x-muted hover:text-x-ink hover:bg-x-hover border border-x-line transition-colors duration-[80ms] shrink-0 cursor-pointer"
                title="Attach images (or paste / drag & drop)"
              >
                <Paperclip size={12} />
              </Button>

              <div className="w-px h-4 bg-x-line mx-0.5 shrink-0" />

              <div className="flex bg-x-surface-2 p-0.5 rounded-md border border-x-line">
                {PRIORITIES.map((p, i) => {
                  const isSelected = priority === p
                  const accentClass = p === 'critical' ? 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/30' :
                                      p === 'high' ? 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/30' :
                                      'text-x-ink-secondary bg-x-surface border-x-line-strong'
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPriority(p)}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded border transition-colors duration-[80ms] ease-x ${
                        isSelected
                          ? accentClass
                          : 'bg-transparent border-transparent text-x-muted hover:text-x-ink-secondary'
                      }`}
                      title={`Alt+${i + 1}`}
                    >
                      {p}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5">
              <span className="hidden sm:inline text-[11px] text-x-faint font-mono">⌘↵ save</span>
              <Button type="submit"
                onClick={handleCreate}
                disabled={creating || !title.trim() || !workspaceId}
                className="flex items-center justify-center gap-1.5 h-[30px] px-4 text-[13px] bg-x-accent hover:bg-x-accent-ink disabled:opacity-40 text-x-on-accent font-medium active:scale-[0.98] transition-colors duration-[80ms] ease-x cursor-pointer"
              >
                <Zap size={13} strokeWidth={1.75} />
                {creating ? 'saving...' : 'Create'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {annotatingImage && (
        <ImageAnnotator
          imageSrc={annotatingImage.url}
          onSave={handleAnnotationSave}
          onClose={() => setAnnotatingImage(null)}
        />
      )}
    </div>
  )
}
