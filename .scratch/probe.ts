import { GitShell } from '/Users/matt/Documents/GitHub/gitq/.worktrees/rebase-hardening/src/core/git-shell.ts';
import { createSandboxRepo, commit } from '/Users/matt/Documents/GitHub/gitq/.worktrees/rebase-hardening/tests/integration/helpers.ts';

const repo = await createSandboxRepo();
await commit(repo.dir, repo.git, 'file-a.txt', 'commit A\n', 'commit A');
const aSha = repo.git('rev-parse', 'HEAD');
repo.git('checkout', '-b', 'feat/base');
const t1 = await commit(repo.dir, repo.git, 'file-t1.txt', 'commit T1\n', 'commit T1');
await commit(repo.dir, repo.git, 'file-t2.txt', 'commit T2\n', 'commit T2');
repo.git('checkout', '-b', 'feat/child');
await commit(repo.dir, repo.git, 'file-e.txt', 'commit E\n', 'commit E');
repo.git('checkout', 'feat/base');
repo.git('reset', '--hard', 'main');
repo.git('cherry-pick', t1);
await commit(repo.dir, repo.git, 'file-t2.txt', 'commit T2 prime\n', 'commit T2 prime');
repo.git('checkout', 'main');

console.log('oldBase(mb child,base):', await GitShell.getMergeBase(repo.dir, 'feat/child', 'feat/base'), 'A:', aSha);
const entries = await GitShell.cherry(repo.dir, 'feat/base', 'feat/child', aSha);
console.log('cherry entries:', entries);
const mt = await GitShell.mergeTreeDryRun(repo.dir, 'feat/base', 'feat/child', aSha);
console.log('mergeTree conflicts:', mt);
console.log('raw merge-tree:', repo.git('merge-tree', '--write-tree', `--merge-base=${aSha}`, 'feat/base', 'feat/child'));
