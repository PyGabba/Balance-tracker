import { useState } from "react";
import { formattaValuta } from "../../lib/format.js";
import { mese } from "../../lib/i18n.js";
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

// ─── Portfolio value chart ───
// All series are arrays of { date: "YYYY-MM-DD", value } placed by DATE on a
// real time axis (weekly snapshots aren't evenly spaced, and a purchase has to
// be a vertical step on its day):
//   value      the real recorded values (value points also carry `invested`,
//              the last one is today's live value)
//   invested   what was put in, a step line — the gap to `value` is the gain
//   prediction a dashed continuation of the value line, muted so it reads as
//              "projected", not "measured"
// Tap or hover to read any recorded point.
const DAY = 24 * 60 * 60 * 1000;
const toTime = (iso) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)).getTime();
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function LineChart({ value, invested = [], prediction = [], domain, height = 150, formatValue = (v) => v, formatAxis = formatValue, lang = "it", labels = {} }) {
  const [hover, setHover] = useState(null);
  if (!domain || !value.length) return null;

  const t0 = toTime(domain.start);
  const tEnd = Math.max(toTime(domain.end), ...(prediction.length ? [toTime(prediction[prediction.length - 1].date)] : [0]));
  const t1 = tEnd > t0 ? tEnd : t0 + DAY;
  const toX = (date) => ((toTime(date) - t0) / (t1 - t0)) * 100;

  const all = [...value, ...invested, ...prediction].map(p => p.value);
  const lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.12 || hi * 0.05 || 1;
  const yMin = Math.max(0, lo - pad), yMax = hi + pad;
  const toY = (v) => 100 - ((v - yMin) / (yMax - yMin)) * 100;
  const pts = (series) => series.map(p => `${toX(p.date)},${toY(p.value)}`).join(" ");

  const last = value[value.length - 1];
  const gain = last.invested > 0 ? last.value - last.invested : null;
  const gainPct = gain !== null ? (gain / last.invested) * 100 : null;
  const isUp = gain === null || gain >= 0;
  const lineColor = isUp ? color.positive : color.negative;
  const lastPrediction = prediction[prediction.length - 1];
  const predictionPts = prediction.length ? pts([last, ...prediction]) : "";

  const spanDays = (t1 - t0) / DAY;
  const fmtDate = (ms, withYear = false) => {
    const d = new Date(ms);
    const mon = mese(d.getMonth(), lang).toLowerCase();
    if (withYear) return `${d.getDate()} ${mon} ${d.getFullYear()}`;
    return spanDays > 270 ? `${mon} ${String(d.getFullYear()).slice(2)}` : `${d.getDate()} ${mon}`;
  };
  const xTicks = [0, 1 / 3, 2 / 3, 1].map(f => ({ f, label: fmtDate(t0 + f * (t1 - t0)) }));
  const yTicks = [0, 0.5, 1].map(f => yMin + f * (yMax - yMin));

  function nearestPoint(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const target = t0 + clamp((e.clientX - rect.left) / rect.width, 0, 1) * (t1 - t0);
    let best = 0;
    value.forEach((p, i) => { if (Math.abs(toTime(p.date) - target) < Math.abs(toTime(value[best].date) - target)) best = i; });
    setHover(best);
  }
  const hp = hover !== null ? value[hover] : null;
  const hpGain = hp && hp.invested > 0 ? hp.value - hp.invested : null;
  const signed = (n) => `${n >= 0 ? "+" : "−"}${formatValue(Math.abs(n))}`;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: color.textPrimary, fontFamily: displayFont }}>{formatValue(last.value)}</div>
          {gain !== null && (
            <div style={{ fontSize: 11, fontWeight: 600, color: lineColor, marginTop: 2, fontFamily: displayFont }}>
              {signed(gain)} ({gainPct >= 0 ? "+" : "−"}{Math.abs(gainPct).toFixed(1).replace(".", ",")}%)
            </div>
          )}
        </div>
        {lastPrediction && (
          <span style={{ fontSize: 11, color: color.textMuted, fontFamily: displayFont }}>~{formatValue(lastPrediction.value)}</span>
        )}
      </div>

      <div style={{ position: "relative", height, touchAction: "pan-y" }}
        onPointerMove={nearestPoint} onPointerDown={nearestPoint} onPointerLeave={() => setHover(null)}>
        {yTicks.map((v, i) => (
          <div key={i} style={{ position: "absolute", left: 0, right: 0, top: `${toY(v)}%`, borderTop: `1px solid ${alpha(color.textMuted, 0.15)}`, pointerEvents: "none" }}>
            <span style={{ position: "absolute", left: 0, top: -12, fontSize: 8, color: color.textMuted, fontFamily: displayFont }}>{formatAxis(v)}</span>
          </div>
        ))}
        <svg viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          {invested.length > 1 && (
            <polyline points={pts(invested)} fill="none" stroke={color.textSecondary} strokeOpacity="0.7" strokeWidth="1.2" vectorEffect="non-scaling-stroke"
              strokeLinecap="round" strokeLinejoin="round" />
          )}
          {value.length > 1 && (
            <polyline points={pts(value)} fill="none" stroke={lineColor} strokeWidth="1.8" vectorEffect="non-scaling-stroke"
              strokeLinecap="round" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 3px ${alpha(lineColor, 0.35)})` }} />
          )}
          {predictionPts && (
            <polyline points={predictionPts} fill="none" stroke={color.textMuted} strokeWidth="1.4" vectorEffect="non-scaling-stroke"
              strokeDasharray="3,3" strokeLinecap="round" strokeLinejoin="round" />
          )}
        </svg>
        {/* HTML dots (an SVG circle would stretch with preserveAspectRatio="none") */}
        {value.map((p, i) => (
          <span key={i} style={{
            position: "absolute", left: `${toX(p.date)}%`, top: `${toY(p.value)}%`, transform: "translate(-50%, -50%)", pointerEvents: "none",
            width: p.live ? 9 : 6, height: p.live ? 9 : 6, borderRadius: "50%", background: lineColor,
            boxShadow: p.live ? `0 0 0 3px ${alpha(lineColor, 0.25)}` : "none",
          }} />
        ))}
        {hp && (
          <>
            <div style={{ position: "absolute", left: `${toX(hp.date)}%`, top: 0, bottom: 0, width: 1, background: alpha(color.textPrimary, 0.25), pointerEvents: "none" }} />
            <div style={{
              position: "absolute", top: -6, left: `clamp(70px, ${toX(hp.date)}%, calc(100% - 70px))`, transform: "translate(-50%, -100%)", pointerEvents: "none",
              background: color.surfaceRaised, border: `1px solid ${color.borderStrong}`, borderRadius: 10, padding: "6px 9px", whiteSpace: "nowrap",
              boxShadow: "0 6px 18px rgba(0,0,0,.45)", fontFamily: displayFont, zIndex: 2,
            }}>
              <div style={{ fontSize: 9, color: color.textMuted, marginBottom: 2 }}>{fmtDate(toTime(hp.date), true)}{hp.live ? ` · ${labels.today || "oggi"}` : ""}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: color.textPrimary }}>{formatValue(hp.value)}</div>
              {hp.invested > 0 && (
                <div style={{ fontSize: 10, color: color.textSecondary, marginTop: 2 }}>{labels.invested || "Investito"}: {formatValue(hp.invested)}</div>
              )}
              {hpGain !== null && (
                <div style={{ fontSize: 10, fontWeight: 600, color: hpGain >= 0 ? color.positive : color.negative }}>{labels.gain || "Guadagno"}: {signed(hpGain)}</div>
              )}
            </div>
          </>
        )}
      </div>

      <div style={{ position: "relative", height: 12, marginTop: 8 }}>
        {xTicks.map(({ f, label }, i) => (
          <span key={i} style={{
            position: "absolute", left: `${f * 100}%`, transform: i === 0 ? "none" : i === xTicks.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
            fontSize: 9, color: color.textMuted, fontFamily: displayFont, whiteSpace: "nowrap",
          }}>{label}</span>
        ))}
      </div>

      <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap", fontFamily: displayFont }}>
        <Legend swatch={<span style={{ width: 12, height: 2, background: lineColor, borderRadius: 1 }} />} text={labels.value || "Valore"} />
        {invested.length > 1 && <Legend swatch={<span style={{ width: 12, height: 2, background: color.textSecondary, opacity: 0.7, borderRadius: 1 }} />} text={labels.invested || "Investito"} />}
        {prediction.length > 0 && <Legend swatch={<span style={{ width: 12, borderTop: `2px dashed ${color.textMuted}` }} />} text={labels.prediction || "Previsione"} />}
      </div>
    </div>
  );
}

function Legend({ swatch, text }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: color.textMuted }}>
      {swatch}{text}
    </span>
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
