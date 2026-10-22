import { User, MessageCircle, Folder, ExternalLink } from 'lucide-react'

export const ENTRY_TYPE_META = {
  user:      { icon: User,          label: 'User',      color: 'text-x-accent', bg: 'bg-x-tint' },
  feedback:  { icon: MessageCircle, label: 'Feedback',  color: 'text-x-accent', bg: 'bg-x-tint' },
  project:   { icon: Folder,        label: 'Project',   color: 'text-x-accent', bg: 'bg-x-tint' },
  reference: { icon: ExternalLink,  label: 'Reference', color: 'text-x-accent', bg: 'bg-x-tint' },
}
