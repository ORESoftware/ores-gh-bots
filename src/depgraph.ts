/**
 * Dependency graph across the fleet.
 *
 * Two independent edge sources, per chat request #102:
 *   1. zed packages   — `.zpkg.toml` (declared) and `.zpkg.lock` (resolved)
 *   2. git submodules — `.gitmodules`
 *
 * A PR in repo X is "disturbed" when a dependency or a dependent of X has moved
 * since the PR last saw its base. That is what makes the nightly pass more than
 * a plain `update-branch` loop.
 */

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface DepEdge {
  readonly from: string; // "owner/repo" that declares the dependency
  readonly to: string; // "owner/repo" being depended upon
  readonly kind: 'zed' | 'submodule';
  readonly spec: string | null; // version range or pinned commit
}

export interface DepGraph {
  readonly edges: readonly DepEdge[];
  dependenciesOf(fullName: string): string[];
  dependentsOf(fullName: string): string[];
}

export function key(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/**
 * Minimal TOML reader for the subset `.zpkg.toml` / `.zpkg.lock` actually use:
 * `[section]` / `[section.sub]` headers plus `key = value` pairs. Deliberately
 * not a general TOML parser — it only has to survive the manifest shape, and a
 * dependency-free nightly job is worth more than total TOML coverage.
 */
export function parseZpkgToml(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header?.[1]) {
      section = header[1].trim();
      out[section] ??= {};
      continue;
    }
    const kv = /^([A-Za-z0-9_.\-"']+)\s*=\s*(.+)$/.exec(line);
    if (!kv || !kv[1] || !kv[2]) continue;
    const k = kv[1].replace(/^["']|["']$/g, '');
    let v = kv[2].trim();
    // Inline table: { version = "1.2.3", repo = "owner/name" }
    const inline = /^\{(.*)\}$/.exec(v);
    if (inline?.[1]) {
      const m = /(?:version|rev|tag)\s*=\s*["']([^"']+)["']/.exec(inline[1]);
      v = m?.[1] ?? inline[1].trim();
    }
    v = v.replace(/^["']|["']$/g, '');
    out[section] ??= {};
    (out[section] as Record<string, string>)[k] = v;
  }
  return out;
}

/** Parses `.gitmodules` into submodule URL entries. */
export function parseGitmodules(text: string): Array<{ path: string; url: string }> {
  const out: Array<{ path: string; url: string }> = [];
  let cur: { path?: string; url?: string } = {};
  const flush = () => {
    if (cur.path && cur.url) out.push({ path: cur.path, url: cur.url });
    cur = {};
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[submodule /.test(line)) {
      flush();
      continue;
    }
    const m = /^(path|url)\s*=\s*(.+)$/.exec(line);
    if (m?.[1] && m[2]) cur[m[1] as 'path' | 'url'] = m[2].trim();
  }
  flush();
  return out;
}

/** Extracts "owner/repo" from any GitHub remote spelling we use. */
export function repoFromGitUrl(url: string): string | null {
  const m =
    /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(url.trim()) ??
    /^\.{1,2}\/(?:\.\.\/)*([^/]+)\/(.+?)(?:\.git)?$/.exec(url.trim());
  if (!m?.[1] || !m[2]) return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * Resolves a zed dependency name to a fleet repo. Zed package names track repo
 * names across the fleet (`sonus-auris-lib` lives in `sonus-auris/sonus-auris-lib`),
 * so an explicit `repo = ` wins and the name is the fallback.
 */
export function resolveZedDep(
  name: string,
  spec: string,
  knownRepos: ReadonlySet<string>,
): string | null {
  if (spec.includes('/') && knownRepos.has(spec)) return spec;
  const direct = [...knownRepos].filter((r) => r.split('/')[1] === name);
  return direct[0] ?? null;
}

export function buildGraph(edges: readonly DepEdge[]): DepGraph {
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.from === e.to) continue; // a repo depending on itself is not an edge
    (forward.get(e.from) ?? forward.set(e.from, new Set()).get(e.from)!).add(e.to);
    (reverse.get(e.to) ?? reverse.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  return {
    edges,
    dependenciesOf: (n) => [...(forward.get(n) ?? [])].sort(),
    dependentsOf: (n) => [...(reverse.get(n) ?? [])].sort(),
  };
}

/**
 * Repos whose movement should cause `fullName` to be re-checked: its direct
 * dependencies, its direct dependents, and (one hop further) the dependents of
 * its dependents, which is where release-driven fleet updates propagate.
 */
export function disturbanceSet(graph: DepGraph, fullName: string): string[] {
  const out = new Set<string>();
  for (const d of graph.dependenciesOf(fullName)) out.add(d);
  for (const d of graph.dependentsOf(fullName)) {
    out.add(d);
    for (const dd of graph.dependentsOf(d)) out.add(dd);
  }
  out.delete(fullName);
  return [...out].sort();
}
