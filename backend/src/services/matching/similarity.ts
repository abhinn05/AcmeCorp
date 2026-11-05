/**
 * String similarity measures used by the reconciliation matcher.
 *
 * These are written out rather than pulled from a library because each one is
 * doing a specific job against bank narrations, and the weighting between them
 * is the interesting part of this problem. All of them return 0..1.
 */

/** Levenshtein edit distance, O(n*m) time with a single row of working memory. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length]!;
}

/** Edit distance expressed as a 0..1 similarity. */
export function levenshteinRatio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/** Jaro similarity: transposition-aware, forgiving of a few swapped characters. */
export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, b.length);
    for (let j = start; j < end; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  transpositions /= 2;

  return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}

/**
 * Jaro-Winkler. The prefix bonus is what makes this the right measure for
 * truncated payer names: a bank writes "ORBIS PKG" for "Orbis Packaging Ltd",
 * and the shared leading characters should count for more than the missing tail.
 */
export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  const base = jaro(a, b);
  if (base < 0.7) return base; // standard cut-off: do not reward weak matches
  let prefix = 0;
  const limit = Math.min(4, a.length, b.length);
  while (prefix < limit && a[prefix] === b[prefix]) prefix += 1;
  return base + prefix * prefixScale * (1 - base);
}

function tokenize(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

/**
 * Token set ratio, in the spirit of the measure of the same name in fuzzywuzzy.
 * It compares the shared tokens against each side's extra tokens, which makes
 * it insensitive to word order and to a narration carrying junk tokens such as
 * "CR", "OCT" or "DUES" alongside the company name.
 */
export function tokenSetRatio(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  const shared = [...aTokens].filter((t) => bTokens.has(t)).sort();
  const aOnly = [...aTokens].filter((t) => !bTokens.has(t)).sort();
  const bOnly = [...bTokens].filter((t) => !aTokens.has(t)).sort();

  const sharedStr = shared.join(' ');
  const left = [sharedStr, aOnly.join(' ')].filter(Boolean).join(' ');
  const right = [sharedStr, bOnly.join(' ')].filter(Boolean).join(' ');

  return Math.max(
    levenshteinRatio(sharedStr, left),
    levenshteinRatio(sharedStr, right),
    levenshteinRatio(left, right),
  );
}

/** Jaccard index over word tokens: shared vocabulary, ignoring repetition. */
export function tokenJaccard(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 && bTokens.size === 0) return 1;
  let intersection = 0;
  for (const t of aTokens) if (bTokens.has(t)) intersection += 1;
  const union = aTokens.size + bTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Character n-grams, padded so that word boundaries carry information. */
export function charNgrams(value: string, n = 3): string[] {
  const padded = ` ${value.replace(/\s+/g, ' ').trim()} `;
  if (padded.length < n) return [padded];
  const grams: string[] = [];
  for (let i = 0; i <= padded.length - n; i += 1) grams.push(padded.slice(i, i + n));
  return grams;
}

function termFrequency(grams: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const g of grams) tf.set(g, (tf.get(g) ?? 0) + 1);
  return tf;
}

/**
 * Character 3-gram TF-IDF cosine similarity, fitted over the known payer names.
 *
 * Inverse document frequency is what earns this its place: n-grams from
 * "PRIVATE LIMITED" or "PVT LTD" appear in most of the customer names and so
 * carry almost no evidence, while the n-grams of "QUILLON" appear in exactly
 * one. Weighting by IDF stops a narration matching every Indian company at once.
 */
export class NgramTfIdf {
  private readonly idf = new Map<string, number>();
  private readonly n: number;

  constructor(corpus: string[], n = 3) {
    this.n = n;
    const documentCount = Math.max(corpus.length, 1);
    const documentFrequency = new Map<string, number>();
    for (const doc of corpus) {
      for (const gram of new Set(charNgrams(doc, n))) {
        documentFrequency.set(gram, (documentFrequency.get(gram) ?? 0) + 1);
      }
    }
    for (const [gram, df] of documentFrequency) {
      // Smoothed IDF, so an unseen n-gram is informative rather than infinite.
      this.idf.set(gram, Math.log((documentCount + 1) / (df + 1)) + 1);
    }
  }

  private vector(value: string): Map<string, number> {
    const tf = termFrequency(charNgrams(value, this.n));
    const vec = new Map<string, number>();
    for (const [gram, count] of tf) {
      // An n-gram never seen while fitting gets the maximum smoothed weight.
      const weight = this.idf.get(gram) ?? Math.log(2) + 1;
      vec.set(gram, count * weight);
    }
    return vec;
  }

  similarity(a: string, b: string): number {
    const va = this.vector(a);
    const vb = this.vector(b);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (const [, w] of va) normA += w * w;
    for (const [gram, w] of vb) {
      normB += w * w;
      const other = va.get(gram);
      if (other !== undefined) dot += other * w;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

/**
 * Is `short` what you get by deleting letters from `long` without reordering?
 * "PKG" is a contraction of "PACKAGING" in exactly this sense. The first letter
 * must agree and the contraction may not be absurdly short, otherwise almost
 * any three letters are a subsequence of a long enough word.
 */
export function isContractionOf(short: string, long: string): boolean {
  if (short.length < 3 || short.length >= long.length) return false;
  if (short[0] !== long[0]) return false;
  if (short.length / long.length < 0.25) return false;

  let i = 0;
  for (let j = 0; j < long.length && i < short.length; j += 1) {
    if (short[i] === long[j]) i += 1;
  }
  return i === short.length;
}

/**
 * Shared token coverage: how many of the shorter string's words are prefixes or
 * contractions of the other's words. "ORBIS PKG" scores 1 against
 * "ORBIS PACKAGING", which is precisely the abbreviation pattern banks use and
 * which edit distance punishes.
 */
export function abbreviationCoverage(short: string, long: string): number {
  const shortTokens = tokenize(short);
  const longTokens = tokenize(long);
  if (shortTokens.length === 0 || longTokens.length === 0) return 0;

  let covered = 0;
  const used = new Set<number>();
  for (const token of shortTokens) {
    let bestIndex = -1;
    let bestLength = 0;
    for (let i = 0; i < longTokens.length; i += 1) {
      if (used.has(i)) continue;
      const candidate = longTokens[i]!;
      const related =
        candidate.startsWith(token) ||
        token.startsWith(candidate) ||
        isContractionOf(token, candidate) ||
        isContractionOf(candidate, token);
      if (related) {
        const length = Math.min(token.length, candidate.length);
        if (length > bestLength) {
          bestLength = length;
          bestIndex = i;
        }
      }
    }
    if (bestIndex >= 0 && bestLength >= 3) {
      used.add(bestIndex);
      covered += 1;
    }
  }
  return covered / shortTokens.length;
}
