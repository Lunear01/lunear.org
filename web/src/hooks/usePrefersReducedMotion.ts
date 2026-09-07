import { useEffect, useState } from "react";

/**
 * True when the user's OS/browser requests reduced motion. CSS handles the
 * transition/animation side of this via `@media (prefers-reduced-motion:
 * reduce)` rules in global.css; this hook exists only for the handful of
 * JS-driven staggered `setTimeout` reveals (poker's board-card flip and
 * showdown reveal stagger) that CSS alone can't suppress the *timing* of —
 * without this, a reduced-motion user would still see cards pop in one at a
 * time on a delay, just without the rotation, instead of all at once.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = () => setReduced(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return reduced;
}
