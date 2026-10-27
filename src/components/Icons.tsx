import type { SVGProps } from 'react'
import { SOCIAL_ICON_VIEWBOX, SOCIAL_ICONS } from '../lib/socialIcons'
import type { SocialKey } from '../lib/socials'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

/**
 * Microsoft's Fluent System Icons (https://github.com/microsoft/fluentui-system-icons, MIT
 * licence), the 20px regular set, drawn in the text's own colour.
 */
function fluent(paths: string[]) {
  return function FluentIcon({ size = 20, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
        {...rest}
      >
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    )
  }
}

export const SearchIcon = fluent(['M13.73 14.44a6.5 6.5 0 1 1 .7-.7l3.42 3.4a.5.5 0 0 1-.63.77l-.07-.06zm-.71-.71A5.5 5.5 0 0 0 15 9.5a5.5 5.5 0 1 0-1.98 4.23'])
export const CloseIcon = fluent(['m4.09 4.22.06-.07a.5.5 0 0 1 .63-.06l.07.06L10 9.29l5.15-5.14a.5.5 0 0 1 .63-.06l.07.06c.18.17.2.44.06.63l-.06.07L10.71 10l5.14 5.15c.18.17.2.44.06.63l-.06.07a.5.5 0 0 1-.63.06l-.07-.06L10 10.71l-5.15 5.14a.5.5 0 0 1-.63.06l-.07-.06a.5.5 0 0 1-.06-.63l.06-.07L9.29 10 4.15 4.85a.5.5 0 0 1-.06-.63l.06-.07z'])
export const ExternalIcon = fluent(['M6 4a2 2 0 0 0-2 2v8c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2v-2.5a.5.5 0 0 1 1 0V14a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h2.5a.5.5 0 0 1 0 1zm5-.5c0-.28.22-.5.5-.5h5c.28 0 .5.22.5.5v5a.5.5 0 0 1-1 0V4.7l-4.15 4.15a.5.5 0 0 1-.7-.7L15.29 4H11.5a.5.5 0 0 1-.5-.5'])
export const LinkIcon = fluent(['M8 6a.5.5 0 0 1 .09 1H6a3 3 0 0 0-.2 6H8a.5.5 0 0 1 .09 1H6a4 4 0 0 1-.22-8H8m6 0a4 4 0 0 1 .22 8H12a.5.5 0 0 1-.09-1H14a3 3 0 0 0 .2-6H12a.5.5 0 0 1-.09-1H14M6 9.5h8a.5.5 0 0 1 .09 1H6a.5.5 0 0 1-.09-1zh8z'])
export const BackIcon = fluent(['M9.16 16.87a.5.5 0 1 0 .67-.74L3.67 10.5H17.5a.5.5 0 0 0 0-1H3.67l6.16-5.63a.5.5 0 0 0-.67-.74L2.24 9.44a.75.75 0 0 0 0 1.11z'])
export const DirectionsIcon = fluent(['M7.88 1.88a3 3 0 0 1 4.24 0l6 6a3 3 0 0 1 0 4.24l-6 6a3 3 0 0 1-4.24 0l-6-6a3 3 0 0 1 0-4.24zm3.53.7a2 2 0 0 0-2.83 0l-6 6a2 2 0 0 0 0 2.83l6 6a2 2 0 0 0 2.83 0l6-6a2 2 0 0 0 0-2.83zm-.76 2.57c.2-.2.5-.2.7 0l2 2c.2.2.2.5 0 .7l-2 2a.5.5 0 0 1-.7-.7L11.79 8H10a2 2 0 0 0-2 2v3a.5.5 0 0 1-1 0v-3a3 3 0 0 1 3-3h1.8l-1.15-1.15a.5.5 0 0 1 0-.7'])
export const PinIcon = fluent(['M5.05 4.05a7 7 0 1 1 9.9 9.9l-1.13 1.12-2.43 2.37a2 2 0 0 1-2.64.12l-.14-.12-2.04-1.99-1.52-1.5a7 7 0 0 1 0-9.9m9.2.7a6 6 0 0 0-8.67 8.32l.17.18.58.57 2.98 2.9.09.08a1 1 0 0 0 1.2 0l.1-.08 2.22-2.17 1.32-1.3.18-.18a6 6 0 0 0-.18-8.31M10 6.26a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5m0 1a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5'])
export const CheckIcon = fluent(['M3.37 10.17a.5.5 0 0 0-.74.66l4 4.5c.19.22.52.23.72.02l10.5-10.5a.5.5 0 0 0-.7-.7L7.02 14.27z'])
export const ListIcon = fluent(['M2 4.5c0-.28.22-.5.5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5m0 10c0-.28.22-.5.5-.5h10a.5.5 0 0 1 0 1h-10a.5.5 0 0 1-.5-.5M2.5 9a.5.5 0 0 0 0 1h15a.5.5 0 0 0 0-1z'])
export const LayersIcon = fluent(['M10.5 3.12a1 1 0 0 0-1 0L3.47 6.64a1 1 0 0 0 0 1.72l6.02 3.5a1 1 0 0 0 1 0l6.01-3.5a1 1 0 0 0 0-1.72zm-1 1.16a1 1 0 0 1 1 0L16 7.5l-5.5 3.2a1 1 0 0 1-1 0L3.99 7.5zM3.06 9.65l6.44 3.62a1 1 0 0 0 .98 0l6.44-3.62a1 1 0 0 1-.42 1.26l-6 3.5a1 1 0 0 1-1.01 0l-6.01-3.5a1 1 0 0 1-.42-1.26m0 2.45 6.44 3.63a1 1 0 0 0 .98 0l6.44-3.63a1 1 0 0 1-.42 1.26l-6 3.5a1 1 0 0 1-1.01 0l-6.01-3.5a1 1 0 0 1-.42-1.26'])
export const ChevronDownIcon = fluent(['M15.85 7.65c.2.2.2.5 0 .7l-5.46 5.49a.55.55 0 0 1-.78 0L4.15 8.35a.5.5 0 1 1 .7-.7L10 12.8l5.15-5.16c.2-.2.5-.2.7 0'])

/** The brand mark: a kōwhai ring on harbour ink. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <circle cx="32" cy="32" r="30" fill="#12333a" />
      <circle cx="32" cy="32" r="17" fill="none" stroke="#f2b705" strokeWidth="5" />
      <circle cx="32" cy="32" r="7" fill="#fff" />
    </svg>
  )
}

export function Spinner({ size = 18, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={`animate-spin motion-reduce:animate-none ${className}`}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/** A platform's one-colour logo, in the text's own colour (shared with the static pages). */
export function SocialIcon({ platform, size = 16, className }: { platform: SocialKey; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={SOCIAL_ICON_VIEWBOX}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {SOCIAL_ICONS[platform].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
