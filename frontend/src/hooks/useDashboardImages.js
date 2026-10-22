import { useState, useRef, useEffect } from 'react'

// Dashboard image paste / drop / upload / annotate — extracted from App.jsx (god-component carve,
// slice 1). Self-contained: owns the pasted-image list + the in-progress annotation, and revokes
// object URLs on unmount. Returns state + setters + handlers so App.jsx call sites stay identical.
export default function useDashboardImages() {
  const [dashboardPastedImages, setDashboardPastedImages] = useState([])
  const [dashboardAnnotatingImage, setDashboardAnnotatingImage] = useState(null)
  const [isDashboardDragging, setIsDashboardDragging] = useState(false)
  const dashboardFileInputRef = useRef(null)

  const handleDashboardUploadImage = async (file) => {
    try {
      const formData = new FormData()
      formData.append('file', file, file.name)
      const res = await fetch('/api/paste-image', { method: 'POST', body: formData })
      if (!res.ok) throw new Error('Upload server error')
      const data = await res.json()

      const newEntry = {
        url: data.url,
        path: data.path,
        filename: data.filename,
        previewUrl: URL.createObjectURL(file),
      }
      setDashboardPastedImages((prev) => [...prev, newEntry])
    } catch (err) {
      console.error('Failed to upload image:', err)
    }
  }

  const handleDashboardPaste = async (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) {
          await handleDashboardUploadImage(file)
        }
      }
    }
  }

  const handleDashboardDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDashboardDragging(true)
  }

  const handleDashboardDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDashboardDragging(false)
  }

  const handleDashboardDrop = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDashboardDragging(false)

    const files = e.dataTransfer?.files
    if (files && files.length > 0) {
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          await handleDashboardUploadImage(file)
        }
      }
    }
  }

  const handleDashboardFileChange = async (e) => {
    const files = e.target.files
    if (files && files.length > 0) {
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          await handleDashboardUploadImage(file)
        }
      }
    }
    e.target.value = ''
  }

  const removeDashboardPastedImage = (idx) => {
    setDashboardPastedImages((prev) => {
      const img = prev[idx]
      if (img.previewUrl) URL.revokeObjectURL(img.previewUrl)
      return prev.filter((_, i) => i !== idx)
    })
  }

  const handleDashboardAnnotationSave = async (blob) => {
    try {
      const formData = new FormData()
      formData.append('file', blob, 'annotated.png')
      const res = await fetch('/api/paste-image', { method: 'POST', body: formData })
      if (!res.ok) throw new Error('Upload error')
      const data = await res.json()

      const idx = dashboardAnnotatingImage?.index
      const newEntry = {
        url: data.url,
        path: data.path,
        filename: data.filename,
        previewUrl: URL.createObjectURL(blob),
      }

      setDashboardPastedImages((prev) => {
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
    setDashboardAnnotatingImage(null)
  }

  useEffect(() => {
    return () => {
      dashboardPastedImages.forEach((img) => {
        if (img.previewUrl) URL.revokeObjectURL(img.previewUrl)
      })
    }
  }, [dashboardPastedImages])

  return {
    dashboardPastedImages, setDashboardPastedImages,
    dashboardAnnotatingImage, setDashboardAnnotatingImage,
    isDashboardDragging, setIsDashboardDragging,
    dashboardFileInputRef,
    handleDashboardUploadImage, handleDashboardPaste,
    handleDashboardDragOver, handleDashboardDragLeave, handleDashboardDrop,
    handleDashboardFileChange, removeDashboardPastedImage, handleDashboardAnnotationSave,
  }
}
