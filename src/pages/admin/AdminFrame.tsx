import {
  Body1,
  Button,
  Caption1,
  Card,
  createLightTheme,
  FluentProvider,
  makeStyles,
  mergeClasses,
  Subtitle2,
  Text,
  tokens,
  type BrandVariants,
  type Theme,
} from '@fluentui/react-components'
import { SignOut20Regular } from '@fluentui/react-icons'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { BrandMark } from '../../components/Icons'
import { supabase } from '../../lib/supabase'

/** What the admin pages built in Microsoft's Fluent UI share: the theme, the bar along the top, the summary cards. */

/** The site's teal-blue as a Fluent brand ramp: 80 is the main colour, lower numbers darker. */
const brand: BrandVariants = {
  10: '#001a24', 20: '#002533', 30: '#003142', 40: '#003d52', 50: '#004a63', 60: '#005775', 70: '#006a8e', 80: '#007ea8',
  90: '#1a8db4', 100: '#3a9cc0', 110: '#5aaccb', 120: '#7abcd6', 130: '#9bcde1', 140: '#bcdeeb', 150: '#dbeef5', 160: '#eef7fa',
}
/** Fluent's light theme in the site's colours, with 16px body text: easier to read than Fluent's 14px. */
export const theme: Theme = {
  ...createLightTheme(brand),
  colorNeutralForeground1: '#0b1419',
  colorNeutralForeground2: '#26333a',
  colorNeutralForeground3: '#3a4850',
  colorNeutralBackground3: '#f5f8f9',
  colorNeutralStroke2: '#ddedf3',
  fontSizeBase200: '14px',
  lineHeightBase200: '20px',
  fontSizeBase300: '16px',
  lineHeightBase300: '22px',
  fontSizeBase400: '18px',
  lineHeightBase400: '24px',
}
/** The dark bar along the top, as on the map and browse pages: white text, an orange focus ring. */
const barTheme: Partial<Theme> = {
  colorNeutralBackground1: '#1a242c',
  colorNeutralBackground1Hover: '#2a4148',
  colorNeutralBackground1Pressed: '#0a1418',
  colorSubtleBackgroundHover: '#2a4148',
  colorSubtleBackgroundPressed: '#0a1418',
  colorNeutralForeground1: '#ffffff',
  colorNeutralForeground1Hover: '#ffffff',
  colorNeutralForeground1Pressed: '#ffffff',
  colorNeutralForeground2: '#ffffff',
  colorNeutralForeground2Hover: '#ffffff',
  colorNeutralForeground2Pressed: '#ffffff',
  colorNeutralForeground2BrandHover: '#ffffff',
  colorNeutralForeground2BrandPressed: '#ffffff',
  colorNeutralForeground3: '#94a8b2',
  colorNeutralStroke1: '#4a6470',
  colorNeutralStroke1Hover: '#94a8b2',
  colorNeutralStroke1Pressed: '#94a8b2',
  colorStrokeFocus2: '#fbb36a',
}

const useStyles = makeStyles({
  bar: { flex: 'none' },
  appBar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px 16px',
    padding: '8px 16px',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  brand: { display: 'flex', alignItems: 'center', gap: '10px' },
  appNav: { marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' },
  email: { color: tokens.colorNeutralForeground3, '@media (max-width: 640px)': { display: 'none' } },
  muted: { color: tokens.colorNeutralForeground3 },
  kpi: { display: 'grid', gap: '8px', alignContent: 'start' },
  kpiHead: { display: 'flex', alignItems: 'center', gap: '12px', color: tokens.colorNeutralForeground2 },
  icon: {
    display: 'grid',
    placeItems: 'center',
    width: '36px',
    height: '36px',
    borderRadius: tokens.borderRadiusLarge,
    flex: 'none',
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  danger: { backgroundColor: tokens.colorStatusDangerBackground1, color: tokens.colorStatusDangerForeground1 },
  warning: { backgroundColor: tokens.colorStatusWarningBackground1, color: tokens.colorStatusWarningForeground3 },
  kpiValue: {
    fontFamily: tokens.fontFamilyBase,
    fontSize: tokens.fontSizeHero800,
    lineHeight: tokens.lineHeightHero800,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
})

const PAGES = [
  { path: '/admin/triage', label: 'Location review' },
  { path: '/admin/returns', label: 'Annual Return checks' },
  { path: '/admin/usage', label: 'Map usage' },
] as const

/** The bar along the top: the other admin pages, the public map, and signing out. */
export function AdminBar({ email, current }: { email: string | null; current: (typeof PAGES)[number]['path'] }) {
  const s = useStyles()
  const navigate = useNavigate()
  return (
    <FluentProvider theme={barTheme} className={s.bar}>
      <header className={s.appBar}>
        <div className={s.brand}>
          <BrandMark size={24} />
          <Subtitle2>NZ Charities Map</Subtitle2>
          <Caption1 className={s.muted}>Admin</Caption1>
        </div>
        <nav aria-label="Admin" className={s.appNav}>
          {PAGES.filter((p) => p.path !== current).map((p) => (
            <Button key={p.path} appearance="subtle" onClick={() => navigate(p.path)}>
              {p.label}
            </Button>
          ))}
          <Button appearance="subtle" as="a" href="/">
            Public map
          </Button>
          {email && <Caption1 className={s.email}>{email}</Caption1>}
          <Button appearance="secondary" icon={<SignOut20Regular />} onClick={() => void supabase.auth.signOut()}>
            Sign out
          </Button>
        </nav>
      </header>
    </FluentProvider>
  )
}

/** A summary card: an icon, what it counts, the number, and a line under it. */
export function Kpi({ icon, tone, label, value, foot }: { icon: ReactNode; tone?: 'danger' | 'warning'; label: string; value: string; foot: string }) {
  const s = useStyles()
  return (
    <Card className={s.kpi}>
      <div className={s.kpiHead}>
        <span className={mergeClasses(s.icon, tone === 'danger' && s.danger, tone === 'warning' && s.warning)}>{icon}</span>
        <Body1>{label}</Body1>
      </div>
      <Text className={s.kpiValue}>{value}</Text>
      <Caption1 className={s.muted}>{foot}</Caption1>
    </Card>
  )
}
