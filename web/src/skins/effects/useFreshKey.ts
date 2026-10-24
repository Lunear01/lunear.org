import { useRef } from "react";

/**
 * Returns `key` once it differs from the value seen on mount, so an effect
 * fires for events witnessed live, not on page load or reconnect.
 */
export function useFreshKey<K extends string | number>(key: K | null): K | null {
  const initial = useRef(key);
  return key !== null && key !== initial.current ? key : null;
}
