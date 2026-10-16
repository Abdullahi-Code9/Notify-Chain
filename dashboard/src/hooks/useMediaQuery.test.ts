import { act, renderHook } from '@testing-library/react';
import { useState, useEffect } from 'react';
import { MOBILE_NAV_QUERY, useIsMobileNav, useMediaQuery } from './useMediaQuery';

type Listener = (event: MediaQueryListEvent) => void;

function createMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<Listener>();

  const mql = {
    get matches() {
      return matches;
    },
    media: MOBILE_NAV_QUERY,
    onchange: null,
    addEventListener: (_: string, listener: Listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_: string, listener: Listener) => {
      listeners.delete(listener);
    },
    addListener: (listener: Listener) => {
      listeners.add(listener);
    },
    removeListener: (listener: Listener) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => true,
    setMatches(next: boolean) {
      matches = next;
      listeners.forEach((listener) =>
        listener({ matches: next, media: MOBILE_NAV_QUERY } as MediaQueryListEvent),
      );
    },
  };

  return mql;
}

describe('useMediaQuery (#681)', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('returns the initial matchMedia result', () => {
    const mql = createMatchMedia(true);
    window.matchMedia = jest.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;

    const { result } = renderHook(() => useMediaQuery(MOBILE_NAV_QUERY));
    expect(result.current).toBe(true);
  });

  it('updates when the viewport crosses the breakpoint', () => {
    const mql = createMatchMedia(true);
    window.matchMedia = jest.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;

    const { result } = renderHook(() => useIsMobileNav());
    expect(result.current).toBe(true);

    act(() => {
      mql.setMatches(false);
    });

    expect(result.current).toBe(false);
  });

  it('clears mobile-only drawer state when resizing to desktop', () => {
    const mql = createMatchMedia(true);
    window.matchMedia = jest.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;

    const { result } = renderHook(() => {
      const isMobileNav = useIsMobileNav();
      const [drawerOpen, setDrawerOpen] = useState(true);

      useEffect(() => {
        if (!isMobileNav && drawerOpen) {
          setDrawerOpen(false);
        }
      }, [isMobileNav, drawerOpen]);

      return { isMobileNav, drawerOpen, setDrawerOpen };
    });

    expect(result.current.isMobileNav).toBe(true);
    expect(result.current.drawerOpen).toBe(true);

    act(() => {
      mql.setMatches(false);
    });

    expect(result.current.isMobileNav).toBe(false);
    expect(result.current.drawerOpen).toBe(false);
  });
});
