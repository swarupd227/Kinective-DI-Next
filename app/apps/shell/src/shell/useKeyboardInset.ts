import { useEffect } from 'react';

/**
 * iOS Safari doesn't resize the page for the on-screen keyboard: it only shrinks the visual viewport
 * and scrolls the page, which pushes the header away and can leave the ask box behind the keyboard.
 * On a phone this sizes the shell to the visible area while the keyboard is up. Android Chrome
 * resizes the page itself (interactive-widget=resizes-content in index.html), so there the two
 * heights match and nothing changes.
 */
export function useKeyboardInset(enabled: boolean) {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) return;
    const root = document.documentElement;
    const update = () => {
      // A pinch zoom also shrinks the visual viewport; only the keyboard counts.
      const keyboard = vv.scale === 1 && window.innerHeight - vv.height > 120;
      if (keyboard) {
        root.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
        window.scrollTo(0, 0);
      } else {
        root.style.removeProperty('--app-height');
      }
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--app-height');
    };
  }, [enabled]);
}
