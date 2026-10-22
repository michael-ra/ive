import { ChevronRight } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { getLanguage, subscribeLanguage } from '../../lib/i18n'

// Explanations are opt-in. Native details keeps touch, keyboard and screen-reader
// behavior consistent, without a hover-only tooltip or another modal.
export default function HelpDetails({ label, children, className = '', onToggle }) {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage)
  return <details className={`ive-help-details ${className}`} onToggle={onToggle}>
    <summary><ChevronRight size={13} aria-hidden="true" /><span>{label || (language === 'de' ? 'Mehr erfahren' : 'Learn more')}</span></summary>
    <div className="ive-help-content">{children}</div>
  </details>
}
