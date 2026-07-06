// Tiny hand-rolled SVG bar/pie charts — no charting library, keeps the
// zero-dependency architecture. Good enough for a handful of categories.

const PALETTE = ['#2b6cb0', '#1a7f5a', '#b45309', '#b02a2a', '#6b46c1', '#0e7490', '#a16207', '#9f1239', '#374151', '#0f766e'];

export function barChart(data, { width = 480, height = 220, money = false } = {}) {
  if (!data.length) return '<p class="small muted">No data yet.</p>';
  const padLeft = 40, padBottom = 60, padTop = 16, padRight = 10;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const max = Math.max(...data.map(d => d.value), 1);
  const barW = plotW / data.length;

  const bars = data.map((d, i) => {
    const barH = max > 0 ? (d.value / max) * plotH : 0;
    const x = padLeft + i * barW + barW * 0.15;
    const w = barW * 0.7;
    const y = padTop + (plotH - barH);
    const color = PALETTE[i % PALETTE.length];
    const label = String(d.label).length > 10 ? String(d.label).slice(0, 9) + '…' : d.label;
    const valueLabel = money ? '$' + Math.round(d.value).toLocaleString() : Math.round(d.value).toLocaleString();
    return `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}" rx="3"></rect>
      <text x="${(x + w / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="11" text-anchor="middle" fill="#1f2328">${escXml(valueLabel)}</text>
      <text x="${(x + w / 2).toFixed(1)}" y="${(padTop + plotH + 16).toFixed(1)}" font-size="11" text-anchor="middle" fill="#6b7280" transform="rotate(-30 ${(x + w / 2).toFixed(1)} ${(padTop + plotH + 16).toFixed(1)})">${escXml(label)}</text>
    `;
  }).join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">${bars}</svg>`;
}

export function pieChart(data, { size = 220 } = {}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (!total) return '<p class="small muted">No data yet.</p>';
  const cx = size / 2, cy = size / 2, r = size / 2 - 6;
  let angle = -Math.PI / 2;
  const slices = data.map((d, i) => {
    const frac = d.value / total;
    const start = angle;
    const end = angle + frac * Math.PI * 2;
    angle = end;
    const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
    const large = end - start > Math.PI ? 1 : 0;
    const color = PALETTE[i % PALETTE.length];
    const path = frac >= 0.999
      ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
      : `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
    return `<path d="${path}" fill="${color}"><title>${escXml(d.label)}: ${escXml(String(d.value))}</title></path>`;
  }).join('');

  const legend = data.map((d, i) => `
    <div style="display:flex;align-items:center;gap:.4rem;font-size:.82rem;">
      <span style="width:10px;height:10px;border-radius:3px;background:${PALETTE[i % PALETTE.length]};display:inline-block;"></span>
      ${escXml(d.label)} <span class="muted">(${Math.round(d.value / total * 100)}%)</span>
    </div>`).join('');

  return `
    <div style="display:flex;gap:1.2rem;align-items:center;flex-wrap:wrap;">
      <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">${slices}</svg>
      <div style="display:flex;flex-direction:column;gap:.35rem;">${legend}</div>
    </div>
  `;
}

function escXml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
