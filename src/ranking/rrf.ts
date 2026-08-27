/**
 * Reciprocal Rank Fusion（§10 Hybrid Search）：
 *   score(d) = Σ 1 / (k + rank_source(d))，rank 从 1 开始。
 * 只依赖各来源的相对排序，不与原始分数量纲耦合。
 */

export interface RrfCandidate {
  source: string;
  id: string;
  /** 1-based 排名 */
  rank: number;
}

export interface FusedHit {
  id: string;
  score: number;
  sources: string[];
}

export function reciprocalRankFusion(
  lists: RrfCandidate[][],
  k = 60,
): FusedHit[] {
  const scoreById = new Map<string, number>();
  const sourcesById = new Map<string, Set<string>>();

  for (const list of lists) {
    for (const c of list) {
      scoreById.set(c.id, (scoreById.get(c.id) ?? 0) + 1 / (k + c.rank));
      const src = sourcesById.get(c.id) ?? new Set<string>();
      src.add(c.source);
      sourcesById.set(c.id, src);
    }
  }

  return [...scoreById.entries()]
    .map(([id, score]) => ({
      id,
      score,
      sources: [...(sourcesById.get(id) ?? new Set<string>())],
    }))
    .sort((a, b) => b.score - a.score);
}
