import { Link } from 'react-router'
import { FullScreenMessage } from '../components/StatusScreens'

export function NotFound() {
  return (
    <FullScreenMessage title="There's no page at this address">
      <p>Check the link, or go back to the map and search for a charity by name or registration number.</p>
      <p>
        <Link to="/" className="text-link underline-offset-2 hover:text-brand-pressed hover:underline">
          Go to the map
        </Link>
      </p>
    </FullScreenMessage>
  )
}
