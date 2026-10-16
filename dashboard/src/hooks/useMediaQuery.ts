import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query and return whether it currently matches.
 * Used for responsive navigation state restoration (#681).
 */
export function useMediaQuery(query: string): boolean {
  const getMatch = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;

  const [matches, setMatches] = useState(getMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);

    setMatches(media.matches);

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }

    // Safari < 14
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, [query]);

  return matches;
}

/** Matches the dashboard CSS mobile breakpoint (hamburger / drawer layout). */
export const MOBILE_NAV_QUERY = '(max-width: 768px)';

export function useIsMobileNav(): boolean {
  return useMediaQuery(MOBILE_NAV_QUERY);
}
