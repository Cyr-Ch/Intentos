import fs from "node:fs";
import path from "node:path";
import { headSha, isGitRepo } from "../util/git.ts";
import type { KnowledgeStore, RepositoryRow } from "./storage.ts";
import { repoIdFor } from "./indexer.ts";
import { fallbackPolicy, policyForRepo, type Policy } from "./policy.ts";

export interface IndexedRepo {
  repo: RepositoryRow;
  repoPath: string;
  revision: string;
  policy: Policy;
}

/** Load an indexed repository; fails with an actionable message when the index is missing or stale. */
export function loadIndexedRepo(store: KnowledgeStore, repoPathInput: string): IndexedRepo {
  const repoPath = path.resolve(repoPathInput);
  if (!fs.existsSync(repoPath) || !isGitRepo(repoPath)) throw new Error(`${repoPath} is not a Git repository.`);
  const repo = store.getRepository(repoIdFor(repoPath));
  if (!repo) throw new Error(`Repository is not indexed. Run: intentos index ${repoPathInput}`);
  const head = headSha(repoPath);
  if (repo.head_sha !== head) {
    throw new Error(`Index is stale: indexed ${repo.head_sha.slice(0, 10)} but HEAD is ${head.slice(0, 10)}. Run: intentos index ${repoPathInput}`);
  }
  if (!store.indexedRevisions(repo.id).includes(head)) throw new Error(`No graph stored for revision ${head.slice(0, 10)}. Run: intentos index ${repoPathInput}`);
  return { repo, repoPath, revision: head, policy: policyForRepo(repoPath) ?? fallbackPolicy(repoPath) };
}
