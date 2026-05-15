export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  readonly dims: number;
  readonly model: string;
}

// L2-normalize a vector in-place-equivalent (returns a new Float32Array so
// the caller's buffer is not mutated). vec0's default KNN uses L2 distance;
// L2 over unit-length vectors and cosine distance share the same ordering,
// so normalizing on capture lets us use the indexed MATCH path without
// adding a custom distance function.
export function normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec.slice();
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}
