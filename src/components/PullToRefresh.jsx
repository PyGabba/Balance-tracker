import { useRef, useState, useEffect, useCallback } from "react";

// ─── Pull-to-refresh ───
// Replaces the header's explicit reload button: pulling down past THRESHOLD
// while already scrolled to the top of the content triggers the same
// reload the button used to. Native touch listeners (not React's
// onTouchMove, which browsers/React treat as passive by default) so the
// page's own scroll/bounce can actually be suppressed with preventDefault
// while the gesture is in progress.
const THRESHOLD = 70; // px of actual finger movement needed to trigger
const MAX_PULL = 100; // visual cap — pulling further doesn't pull further

export function PullToRefresh({ children, onRefresh, style }) {
  const containerRef = useRef(null);
  const startYRef = useRef(null);
  const pullDistanceRef = useRef(0);
  const refreshingRef = useRef(false);
  const [pullDistance, setPullDistanceState] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const setPull = useCallback((v) => { pullDistanceRef.current = v; setPullDistanceState(v); }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function onTouchStart(e) {
      if (refreshingRef.current) return;
      startYRef.current = el.scrollTop <= 0 ? e.touches[0].clientY : null;
    }

    function onTouchMove(e) {
      if (startYRef.current == null) return;
      if (el.scrollTop > 0) { startYRef.current = null; setPull(0); return; }
      const delta = e.touches[0].clientY - startYRef.current;
      if (delta <= 0) { setPull(0); return; }
      // Only suppress the page's native scroll/bounce once this is
      // unambiguously a pull-down-at-the-top gesture, not an upward scroll
      // that merely started near the top.
      e.preventDefault();
      setPull(Math.min(delta * 0.5, MAX_PULL)); // rubber-band: half-speed follow
    }

    function onTouchEnd() {
      if (startYRef.current == null) return;
      startYRef.current = null;
      if (pullDistanceRef.current >= THRESHOLD) {
        refreshingRef.current = true;
        setRefreshing(true);
        setPull(THRESHOLD);
        Promise.resolve(onRefresh()).finally(() => {
          refreshingRef.current = false;
          setRefreshing(false);
          setPull(0);
        });
      } else {
        setPull(0);
      }
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [onRefresh, setPull]);

  const readyToRelease = pullDistance >= THRESHOLD;

  return (
    <div ref={containerRef} style={{ ...style, overflowY: "auto" }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        height: pullDistance, overflow: "hidden",
        transition: refreshing || pullDistance === 0 ? "height 0.2s ease" : "none",
      }}>
        <span style={{
          display: "inline-block", fontSize: 18,
          color: readyToRelease || refreshing ? "#6C5CE7" : "#555",
          transform: refreshing ? "none" : `rotate(${pullDistance * 3}deg)`,
          animation: refreshing ? "ptr-spin 0.6s linear infinite" : "none",
        }}>↻</span>
      </div>
      <style>{"@keyframes ptr-spin { to { transform: rotate(360deg); } }"}</style>
      {children}
    </div>
  );
}
