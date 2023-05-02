import {useEffect} from 'react';

export function useVHStyleProp(winHeight: number | null) {
  useEffect(() => {
    if (winHeight === null) {
      return;
    }
    const vh = winHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
    return () => {
      document.documentElement.style.removeProperty('--vh');
    };
  }, [winHeight]);
}
