// Compatibility slot: product UI is loaded only when its extension is selected.
import { resolveExtensionPanel } from '../../lib/extensionRegistry'

export default resolveExtensionPanel('gi', 'VoiceControl')
export const AIControlCenter = resolveExtensionPanel('gi', 'AIControlCenter')
