/** Tiny LRU keyed by insertion order bump on get/set. */

export class ExplorerLru<K, V> {
  private map = new Map<K, V>();

  constructor(private capacity: number) {}

  clear() {
    this.map.clear();
  }

  delete(key: K) {
    this.map.delete(key);
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      const firstKey = this.map.keys().next().value as K | undefined;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }
}


export type RepoEntryLike = {
  kind: "dir" | "file" | "submodule";
  name: string;
  path: string;
};

export function explorerListKey(
  owner: string,
  repo: string,
  ref: string,
  pathPosix: string,
) {
  return `${owner.toLowerCase()}\0${repo.toLowerCase()}\0${ref}\0${pathPosix}`;
}

export function explorerRawKey(
  owner: string,
  repo: string,
  ref: string,
  pathPosix: string,
) {
  return `${owner.toLowerCase()}\0${repo.toLowerCase()}\0${ref}\0${pathPosix}`;
}

export function sortRepoExplorerEntries<
  E extends RepoEntryLike,
>(rows: readonly E[]): E[] {
  const rank = (k: RepoEntryLike["kind"]) =>
    k === "dir" ? 0 : k === "submodule" ? 1 : 2;
  return [...rows].sort((a, b) => {
    const dr = rank(a.kind) - rank(b.kind);
    if (dr !== 0) return dr;
    return a.name.localeCompare(b.name, undefined, {
      sensitivity: "base",
    });
  });
}
