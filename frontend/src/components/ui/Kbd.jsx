// A key cap, 11 px, muted. Pass the already formatted combo (formatKeyCombo).
export default function Kbd({ children, className = '' }) {
  return <kbd className={`ive-kbd${className ? ` ${className}` : ''}`}>{children}</kbd>
}
