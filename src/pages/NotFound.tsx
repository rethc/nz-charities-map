import { Link } from 'react-router'
import { FullScreenMessage } from '../components/StatusScreens'

export function NotFound() {
  return (
    <FullScreenMessage title="There's no page at this address">
      <p>Check the link, or go back to the map and search for a charity by name or registration number.</p>
      <p>
        <Link to="/" className="font-semibold underline underline-offset-4">
          Go to the map
        </Link>
      </p>
    </FullScreenMessage>
  )
}
