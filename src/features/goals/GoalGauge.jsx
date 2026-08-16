export function GoalGauge({ current, target, size = 60 }) {
  const pct = target > 0 ? Math.min(current / target, 1) : 0;
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circ = 2 * Math.PI * radius;
  const offset = circ * (1 - pct);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke="#252538" strokeWidth={stroke} />
      <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke={pct >= 1 ? "#4ECDC4" : "#6C5CE7"} strokeWidth={stroke}
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" transform={`rotate(-90 ${size/2} ${size/2})`} style={{transition: "stroke-dashoffset 0.5s"}} />
    </svg>
  );
}
