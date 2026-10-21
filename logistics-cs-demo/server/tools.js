// ============ Mock 工具：查运单 / 查运费时效 / 查知识库 ============
import { SHIPMENTS, CITY_INFO, REMOTE_PROVINCES, FREIGHT_PRODUCTS, KNOWLEDGE_BASE } from './data.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// 知识库检索打分（关键词命中）
export function scoreKnowledge(m) {
  const scored = [];
  for (const entry of KNOWLEDGE_BASE) {
    let score = 0;
    for (const k of entry.keywords) {
      if (m.includes(k)) score += k.length >= 3 ? 3 : 2;
    }
    if (score > 0) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

function resolvePlace(name) {
  if (!name) return null;
  const info = CITY_INFO[name];
  return info ? { name, province: info.province } : null;
}

// 线路类型：同城 0.8 / 省内 1.0 / 跨省 1.2 / 偏远 1.8
export function resolveZone(originName, destName) {
  const o = resolvePlace(originName);
  const d = resolvePlace(destName);
  if (o && d && o.name === d.name) return { key: 'city', multiplier: 0.8, label: '同城' };
  if (o && d && o.province === d.province) return { key: 'intra', multiplier: 1.0, label: '省内' };
  if ((d && REMOTE_PROVINCES.has(d.province)) || (o && REMOTE_PROVINCES.has(o.province))) {
    return { key: 'remote', multiplier: 1.8, label: '偏远地区' };
  }
  return { key: 'cross', multiplier: 1.2, label: '跨省' };
}

function calcPrice(product, weightKg, multiplier) {
  const extra = Math.max(0, Math.ceil(weightKg - 1));
  const raw = (product.first + extra * product.additional) * multiplier;
  return raw >= 100 ? Math.round(raw) : Math.round(raw * 10) / 10;
}

// 工具：查询运单状态
export async function queryShipment({ trackingNo } = {}) {
  await delay(650);
  if (!trackingNo) return { found: false, missingNo: true, summary: '等待用户提供运单号' };
  const shipment = SHIPMENTS[trackingNo.toUpperCase()] || null;
  return {
    found: !!shipment,
    shipment,
    summary: shipment ? `已定位运单 ${shipment.trackingNo} · ${shipment.status}` : `未查到运单 ${trackingNo}`
  };
}

// 工具：查询运费与时效
export async function queryFreight({ origin, destination, weightKg } = {}) {
  await delay(700);
  if (!destination) return { needMore: true, missing: 'destination', summary: '缺少目的地城市，需补充信息' };
  const w = weightKg && weightKg > 0 ? weightKg : 1;
  const originCity = origin || '杭州';
  const zone = resolveZone(originCity, destination);
  const products = FREIGHT_PRODUCTS.map((p) => ({
    name: p.name,
    price: calcPrice(p, w, zone.multiplier),
    eta: p.eta[zone.key]
  }));
  return {
    needMore: false,
    origin: originCity,
    originAssumed: !origin,
    destination,
    weightKg: w,
    zone,
    products,
    summary: `${originCity} → ${destination} · ${w}kg · ${zone.label}`
  };
}

// 工具：知识库检索
export async function queryKnowledge({ query = '', topN = 2 } = {}) {
  await delay(600);
  const matched = scoreKnowledge(query).slice(0, topN);
  return {
    matched,
    empty: matched.length === 0,
    summary: matched.length ? `命中 ${matched.length} 条知识` : '知识库未命中'
  };
}

export const TOOLS = {
  query_shipment: queryShipment,
  query_freight: queryFreight,
  query_knowledge: queryKnowledge
};
