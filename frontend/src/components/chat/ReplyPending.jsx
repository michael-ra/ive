import ProviderLogo from '../ui/ProviderLogo'

export default function ReplyPending({ provider, label = 'Waiting for a reply…' }) {
  return <div className="ive-reply-pending" data-awaiting-reply role="status" aria-live="polite">
    <ProviderLogo provider={provider} className="w-5 h-5 shrink-0" />
    <span className="ive-reply-dots" aria-hidden="true"><i /><i /><i /></span>
    <span>{label}</span>
  </div>
}
