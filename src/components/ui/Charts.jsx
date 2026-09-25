import { formattaValuta } from "../../lib/format.js";
import { color, alpha, displayFont } from "./styles.js";

export function MiniChart({ dati, maxVal }) {
  if (!dati.length) return null;
  const mx = maxVal || Math.max(...dati.map(d => d.valore), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 100 }}>
      {dati.map((d, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
          <div style={{ width: "100%", maxWidth: 28, height: Math.max(2, (d.valore / mx) * 80),
            background: `linear-gradient(180deg, ${d.colore||color.accent} 0%, ${alpha(d.colore||color.accent, 0.53)} 100%)`,
            borderRadius: "4px 4px 0 0", transition: "height 0.5s cubic-bezier(.4,0,.2,1)" }} />
          <span style={{ fontSize: 9, color: color.textMuted, marginTop: 4, fontFamily: displayFont }}>{d.label}</span>
        </div>
      ))}
    </div>
  );
}

// `history` and `prediction` are arrays of { date, value }. `prediction`
// (optional) renders as a dashed continuation of the same line, in a muted
// color, so it reads as "projected" rather than "measured".
export function LineChart({ history, prediction = [], height = 140, formatValue = (v) => v }) {
  if (!history.length) return null;
  const all = [...history, ...prediction];
  const values = all.map(p => p.value);
  const minV = Math.min(...values, 0);
  const maxV = Math.max(...values, 1);
  const range = maxV - minV || 1;
  const n = all.length;
  const w = Math.max(n - 1, 1);
  const toX = (i) => (i / w) * 100;
  const toY = (v) => 100 - ((v - minV) / range) * 100;

  const historyPts = history.map((p, i) => `${toX(i)},${toY(p.value)}`).join(" ");
  const predictionPts = prediction.length
    ? [`${toX(history.length - 1)},${toY(history[history.length - 1].value)}`,
       ...prediction.map((p, i) => `${toX(history.length + i)},${toY(p.value)}`)].join(" ")
    : "";

  const lastHistory = history[history.length - 1];
  const isUp = history.length > 1 ? lastHistory.value >= history[0].value : true;
  const lineColor = isUp ? color.positive : color.negative;

  const step = Math.max(1, Math.round(n / 6));
  const lastPrediction = prediction[prediction.length - 1];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: color.textPrimary, fontFamily: displayFont }}>{formatValue(lastHistory.value)}</span>
        {lastPrediction && (
          <span style={{ fontSize: 11, color: color.textMuted, fontFamily: displayFont }}>~{formatValue(lastPrediction.value)}</span>
        )}
      </div>
      <svg viewBox="0 0 100 100" width="100%" height={height} preserveAspectRatio="none" style={{ overflow: "visible" }}>
        <polyline points={historyPts} fill="none" stroke={lineColor} strokeWidth="1.6" vectorEffect="non-scaling-stroke"
          strokeLinecap="round" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 3px ${alpha(lineColor, 0.35)})` }} />
        {predictionPts && (
          <polyline points={predictionPts} fill="none" stroke={color.textMuted} strokeWidth="1.4" vectorEffect="non-scaling-stroke"
            strokeDasharray="3,3" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
      <div style={{ position: "relative", height: 12, marginTop: 6 }}>
        {all.map((p, i) => (i % step === 0 || i === all.length - 1) ? (
          <span key={i} style={{ position: "absolute", left: `${toX(i)}%`, transform: i === all.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
            fontSize: 8, color: color.textMuted, fontFamily: displayFont, whiteSpace: "nowrap" }}>
            {p.date.slice(5)}
          </span>
        ) : null)}
      </div>
    </div>
  );
}

export function DonutChart({ segmenti }) {
  const total = segmenti.reduce((s, x) => s + x.valore, 0) || 1;
  let accum = 0;
  const archi = segmenti.map(seg => { const pct = seg.valore / total; const start = accum; accum += pct; return { ...seg, start, end: accum }; });
  function arcPath(start, end, r = 42) {
    const s = start*Math.PI*2-Math.PI/2, e = end*Math.PI*2-Math.PI/2;
    const large = end-start > 0.5 ? 1 : 0;
    return `M ${50+r*Math.cos(s)} ${50+r*Math.sin(s)} A ${r} ${r} 0 ${large} 1 ${50+r*Math.cos(e)} ${50+r*Math.sin(e)}`;
  }
  return (
    <svg viewBox="0 0 100 100" width="140" height="140">
      {archi.map((a,i) => <path key={i} d={arcPath(a.start, a.end===1?0.9999:a.end)} fill="none" stroke={a.colore} strokeWidth="12" strokeLinecap="round" style={{filter:"drop-shadow(0 0 3px "+a.colore+"44)"}} />)}
      <text x="50" y="47" textAnchor="middle" fill={color.textPrimary} fontSize="10" fontWeight="700" fontFamily={displayFont}>{formattaValuta(total)}</text>
      <text x="50" y="59" textAnchor="middle" fill={color.textMuted} fontSize="7" fontFamily={displayFont}>totale</text>
    </svg>
  );
}
