import { Cpu, Terminal } from 'lucide-react'
import claude from '../../assets/providers/claude.svg'
import openaiLight from '../../assets/providers/openai-light.svg'
import openaiDark from '../../assets/providers/openai-dark.svg'
import anthropicLight from '../../assets/providers/anthropic-light.svg'
import anthropicDark from '../../assets/providers/anthropic-dark.svg'
import gemini from '../../assets/providers/gemini.svg'
import antigravity from '../../assets/providers/antigravity.png'
import google from '../../assets/providers/google.png'

const BRANDS = {
  claude: [claude],
  codex: [openaiLight, openaiDark],
  openai: [openaiLight, openaiDark],
  chatgpt: [openaiLight, openaiDark],
  anthropic: [anthropicLight, anthropicDark],
  gemini: [gemini],
  gemini_api: [gemini],
  antigravity: [antigravity],
  google: [google],
}

/** Official bundled marks. The adjacent text supplies the accessible name.
 * Unknown/custom engines get a neutral chip, never another provider's brand.
 * OpenAI's official Blossom identifies Codex's provider. See asset SOURCES.md.
 */
export default function ProviderLogo({ provider, className = 'w-4 h-4 shrink-0' }) {
  const key = String(provider || '').toLowerCase()
  const assets = BRANDS[key]
  if (!assets) {
    const Icon = key === 'shell' ? Terminal : Cpu
    return <Icon className={className} aria-hidden="true" />
  }
  return <span className={`ive-provider-logo ${className}`} data-provider-logo={key} aria-hidden="true">
    <img className={assets[1] ? 'ive-provider-logo-light' : undefined} src={assets[0]} alt="" draggable="false" />
    {assets[1] && <img className="ive-provider-logo-dark" src={assets[1]} alt="" draggable="false" />}
  </span>
}
