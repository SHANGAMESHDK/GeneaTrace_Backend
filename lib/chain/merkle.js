import { sha256 } from '../util.js';

const EMPTY_ROOT = sha256('');

export function merkleRoot(leaves) {
  if (!leaves.length) return EMPTY_ROOT;
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256(level[i] + (level[i + 1] ?? level[i])));
    }
    level = next;
  }
  return level[0];
}

/** Sibling path proving `leaves[index]` is included under the root. */
export function merkleProof(leaves, index) {
  const path = [];
  let level = leaves;
  let i = index;
  while (level.length > 1) {
    const isRight = i % 2 === 1;
    const sibling = isRight ? level[i - 1] : (level[i + 1] ?? level[i]);
    path.push({ position: isRight ? 'left' : 'right', hash: sibling });
    const next = [];
    for (let j = 0; j < level.length; j += 2) next.push(sha256(level[j] + (level[j + 1] ?? level[j])));
    level = next;
    i = Math.floor(i / 2);
  }
  return path;
}

export function verifyProof(leaf, path, root) {
  let h = leaf;
  for (const step of path) h = step.position === 'left' ? sha256(step.hash + h) : sha256(h + step.hash);
  return h === root;
}
