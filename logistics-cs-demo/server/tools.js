// ============ Mock 工具：查运单 / 查运费时效 / 查知识库 / 查网点 ============
import { SHIPMENTS, CITY_INFO, REMOTE_PROVINCES, FREIGHT_PRODUCTS, BRANCHES } from './data.js';
import { searchKnowledge } from './knowledge.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 工具：知识库检索（RAG 检索平台 API，失败自动降级本地词法检索）
export async function queryKnowledge({ query = '', topN = 2 } = {}) {
  return searchKnowledge({ query, topN });
}

// 工具：查询营业网点（支持城市 / 区县 / 省份 + 关键词筛选）
export async function queryBranches({ city, keyword = '', topN = 3 } = {}) {
  await delay(600);
  if (!city) return { needMore: true, missing: 'city', summary: '缺少城市，需补充信息' };

  const norm = (s) => String(s || '').replace(/[市区县]$/g, '');
  const kw = String(keyword || '').trim();

  // 依次尝试：城市/区县精确匹配 -> 省份匹配（如"浙江"）-> 包含匹配（如"杭州市"）
  let list = BRANCHES.filter((b) => norm(b.city) === norm(city) || norm(b.district) === norm(city));
  if (!list.length && CITY_INFO[norm(city)]) {
    const prov = CITY_INFO[norm(city)].province;
    list = BRANCHES.filter((b) => CITY_INFO[b.city]?.province === prov);
  }
  if (!list.length) list = BRANCHES.filter((b) => city.includes(b.city));

  if (!list.length) {
    return {
      found: false,
      city,
      empty: true,
      summary: `${city} 暂无收录网点（演示数据仅覆盖部分城市，可建议用户通过小程序查询）`
    };
  }

  // 关键词过滤（区县 / 地标 / 业务类型），未命中时保留全部并标注，避免空结果
  let keywordMatched = false;
  if (kw) {
    const hit = list.filter((b) =>
      [b.name, b.district, b.address, b.landmark, b.hours, b.services.join('')].some((t) => t.includes(kw))
    );
    if (hit.length) {
      list = hit;
      keywordMatched = true;
    }
  }

  const branches = list.slice(0, topN);
  return {
    found: true,
    city,
    keyword: kw || null,
    keywordMatched,
    total: list.length,
    branches,
    summary: `${city}${kw && keywordMatched ? `（${kw}）` : ''} 命中 ${list.length} 个网点`
  };
}

export const TOOLS = {
  query_shipment: queryShipment,
  query_freight: queryFreight,
  query_knowledge: queryKnowledge,
  query_branches: queryBranches
};
