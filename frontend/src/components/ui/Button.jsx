import { forwardRef } from 'react'
import { Loader2 } from 'lucide-react'
import { mergeClasses } from './mergeClasses'

const VARIANTS = {
  default: 'border-x-line-strong bg-x-surface text-x-ink hover:bg-x-hover',
  primary: 'border-transparent bg-x-accent text-x-on-accent hover:bg-x-accent/85',
  destructive: 'border-transparent bg-transparent text-x-danger hover:bg-x-danger/10',
  toggle: 'border-x-line-strong bg-x-surface text-x-ink hover:bg-x-hover',
}

const SELECTED = 'border-x-line-strong bg-x-hover text-x-ink'

const SHAPES = {
  pill: 'rounded-full',
  card: 'rounded-xl',
  tile: 'rounded-md',
}

const DISABLED = 'disabled:cursor-not-allowed disabled:border-dashed disabled:border-x-line-strong disabled:bg-x-surface-2 disabled:text-x-muted disabled:opacity-100 disabled:shadow-none disabled:active:scale-100'

const SIZES = {
  sm: 'min-h-[26px] px-2.5 py-1 text-[11px]',
  md: 'min-h-[30px] px-3 py-1.5 text-xs',
}

const ICON_SIZES = {
  sm: 'h-[26px] w-[26px]',
  md: 'h-[30px] w-[30px]',
}

export const Button = forwardRef(function Button(
  {
    variant = 'default',
    size = 'md',
    icon: Icon,
    iconRight: IconRight,
    loadingIcon: LoadingIcon = Loader2,
    loading = false,
    selected = false,
    shape = 'tile',
    toggleState,
    type = 'button',
    className = '',
    children,
    ...props
  },
  ref,
) {
  const iconSize = size === 'sm' ? 11 : 13
  const resolvedVariant = typeof toggleState === 'boolean' && variant === 'default'
    ? 'toggle'
    : variant

  return (
    <button
      ref={ref}
      type={type}
      role={typeof toggleState === 'boolean' ? 'switch' : undefined}
      aria-checked={typeof toggleState === 'boolean' ? toggleState : undefined}
      className={mergeClasses(`group inline-flex items-center justify-center gap-1.5 border font-medium ${shape === 'card' ? 'whitespace-normal' : 'whitespace-nowrap'} transition-colors duration-[80ms] ease-x active:scale-[.98] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-x-focus ${SHAPES[shape] || SHAPES.pill} ${DISABLED} ${SIZES[size]} ${selected ? SELECTED : VARIANTS[resolvedVariant]}`, className)}
      {...props}
    >
      {loading ? <LoadingIcon size={iconSize} className="animate-spin" /> : Icon ? <Icon size={iconSize} /> : null}
      {children}
      {IconRight && !loading ? <IconRight size={iconSize} /> : null}
      {typeof toggleState === 'boolean' && (
        <span
          aria-hidden="true"
          className={`relative ml-1 h-5 w-9 shrink-0 rounded-full border transition-colors duration-[120ms] ${
            toggleState ? 'border-x-ink bg-x-ink' : 'border-x-line-strong bg-x-surface'
          }`}
        >
          <span
            className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all duration-[120ms] ${
              toggleState ? 'left-[18px] bg-x-surface' : 'left-0.5 bg-x-muted'
            }`}
          />
        </span>
      )}
    </button>
  )
})

export const IconButton = forwardRef(function IconButton(
  {
    icon: Icon,
    label,
    variant = 'default',
    size = 'md',
    selected = false,
    shape = 'tile',
    iconSize: requestedIconSize,
    type = 'button',
    className = '',
    children,
    ...props
  },
  ref,
) {
  const iconSize = requestedIconSize || (size === 'sm' ? 13 : 15)

  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={props.title || label}
      className={mergeClasses(`relative inline-flex shrink-0 items-center justify-center border transition-colors duration-[80ms] ease-x active:scale-[.98] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-x-focus ${SHAPES[shape] || SHAPES.tile} ${DISABLED} ${ICON_SIZES[size]} ${selected ? SELECTED : VARIANTS[variant]}`, className)}
      {...props}
    >
      <Icon size={iconSize} />
      {children}
    </button>
  )
})

export default Button
