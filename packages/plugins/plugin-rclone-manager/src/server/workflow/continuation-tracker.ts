// SPDX-License-Identifier: Apache-2.0

import { JOB_STATUS, type JobModel } from '@nocobase/plugin-workflow';

export interface FlowNodeLike {
  id: number | string;
  key?: string;
  type?: string;
  upstreamId?: number | string | null;
  downstreamId?: number | string | null;
  branchIndex?: number | null;
  downstream?: FlowNodeLike | null;
  upstream?: FlowNodeLike | null;
}

export type ContinuationTraceResult =
  | { kind: 'parked' }
  | { kind: 'needs_exit'; status: number }
  | { kind: 'resume_from_tail'; tailNode: FlowNodeLike | undefined; tailJob: JobModel };

export function isJobAfterAnchor(candidate: JobModel, anchorJob: JobModel): boolean {
  const candId = String(candidate?.id ?? '').trim();
  const anchId = String(anchorJob?.id ?? '').trim();
  if (!candId || !anchId || candId === anchId) {
    return false;
  }
  if (String(candidate.upstreamId ?? '') === anchId) {
    return true;
  }
  if (/^\d+$/.test(candId) && /^\d+$/.test(anchId)) {
    return BigInt(candId) > BigInt(anchId);
  }
  const candTime = candidate.createdAt ? new Date(String(candidate.createdAt)).getTime() : Number.NaN;
  const anchTime = anchorJob.createdAt ? new Date(String(anchorJob.createdAt)).getTime() : Number.NaN;
  if (Number.isFinite(candTime) && Number.isFinite(anchTime) && candTime !== anchTime) {
    return candTime > anchTime;
  }
  return true;
}

function compareJobsAscending(a: JobModel, b: JobModel): number {
  const aId = String(a?.id ?? '').trim();
  const bId = String(b?.id ?? '').trim();
  if (aId === bId) return 0;
  if (/^\d+$/.test(aId) && /^\d+$/.test(bId)) {
    const diff = BigInt(aId) - BigInt(bId);
    return diff < 0n ? -1 : diff > 0n ? 1 : 0;
  }
  const aTime = a?.createdAt ? new Date(String(a.createdAt)).getTime() : Number.NaN;
  const bTime = b?.createdAt ? new Date(String(b.createdAt)).getTime() : Number.NaN;
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
    return aTime - bTime;
  }
  return 0;
}

function maxAnchorJob(a: JobModel, b: JobModel): JobModel {
  return compareJobsAscending(a, b) >= 0 ? a : b;
}

function collectNodesFromGraph(
  startNode: FlowNodeLike | undefined,
  explicitNodes: FlowNodeLike[] | null,
): Map<string, FlowNodeLike> {
  const map = new Map<string, FlowNodeLike>();
  const enqueue = (node: FlowNodeLike | null | undefined) => {
    if (!node || node.id == null) return;
    const key = String(node.id);
    if (map.has(key)) return;
    map.set(key, node);
    if (node.downstream) enqueue(node.downstream);
    if (node.upstream) enqueue(node.upstream);
  };
  if (Array.isArray(explicitNodes)) {
    for (const n of explicitNodes) {
      enqueue(n);
    }
  }
  enqueue(startNode);
  return map;
}

function getDownstreamId(node: FlowNodeLike | undefined): number | string | null {
  if (!node) return null;
  if (node.downstreamId !== undefined && node.downstreamId !== null) {
    return node.downstreamId;
  }
  if (node.downstream?.id !== undefined && node.downstream?.id !== null) {
    return node.downstream.id;
  }
  return null;
}

function getUpstreamNode(node: FlowNodeLike | undefined, nodesById: Map<string, FlowNodeLike>): FlowNodeLike | null {
  if (!node) return null;
  if (node.upstreamId !== undefined && node.upstreamId !== null) {
    return nodesById.get(String(node.upstreamId)) ?? node.upstream ?? null;
  }
  return node.upstream ?? null;
}

function getBranchesOf(parent: FlowNodeLike, nodesById: Map<string, FlowNodeLike>): FlowNodeLike[] {
  const parentId = String(parent.id);
  const branches: FlowNodeLike[] = [];
  for (const candidate of nodesById.values()) {
    const upId = candidate.upstreamId ?? candidate.upstream?.id ?? null;
    if (
      upId != null &&
      String(upId) === parentId &&
      candidate.branchIndex !== null &&
      candidate.branchIndex !== undefined
    ) {
      branches.push(candidate);
    }
  }
  branches.sort((a, b) => Number(a.branchIndex) - Number(b.branchIndex));
  return branches;
}

function findBranchStart(
  node: FlowNodeLike,
  parent: FlowNodeLike,
  nodesById: Map<string, FlowNodeLike>,
): FlowNodeLike | null {
  const parentId = String(parent.id);
  let curr: FlowNodeLike | null = node;
  let guard = 0;
  while (curr && guard < nodesById.size + 4) {
    guard += 1;
    const up = getUpstreamNode(curr, nodesById);
    if (up && String(up.id) === parentId && curr.branchIndex !== null && curr.branchIndex !== undefined) {
      return curr;
    }
    curr = up;
  }
  return null;
}

function findBranchParent(node: FlowNodeLike, nodesById: Map<string, FlowNodeLike>): FlowNodeLike | null {
  let curr: FlowNodeLike | null = node;
  let guard = 0;
  while (curr && guard < nodesById.size + 4) {
    guard += 1;
    if (curr.branchIndex !== null && curr.branchIndex !== undefined) {
      return getUpstreamNode(curr, nodesById);
    }
    curr = getUpstreamNode(curr, nodesById);
  }
  return null;
}

/**
 * Traces the exact workflow continuation path starting from `(startNode, startJob)` across persisted `allJobs`
 * and `explicitNodes`, ensuring sibling branches (e.g. a PENDING `Delay` in another `Parallel` branch) are never
 * mistaken for progress of `startJob`.
 */
export function traceWorkflowContinuation(
  startNode: FlowNodeLike | undefined,
  startJob: JobModel,
  allJobs: JobModel[],
  explicitNodes: FlowNodeLike[] | null,
  consumedTokenMatches: boolean,
): ContinuationTraceResult {
  const sortedJobs = [...allJobs].sort(compareJobsAscending);
  const nodesById = collectNodesFromGraph(startNode, explicitNodes);

  const findJobAfterForNode = (
    nodeId: number | string,
    anchor: JobModel,
    directPrev?: JobModel,
  ): JobModel | undefined => {
    if (directPrev) {
      const byUpstream = sortedJobs.find(
        (item) => String(item.id) !== String(directPrev.id) && String(item.upstreamId ?? '') === String(directPrev.id),
      );
      if (byUpstream) {
        return byUpstream;
      }
    }
    return sortedJobs.find((item) => String(item.nodeId) === String(nodeId) && isJobAfterAnchor(item, anchor));
  };

  const findParentScopeJob = (parentNode: FlowNodeLike, branchJob: JobModel): JobModel | undefined => {
    const matching = sortedJobs.filter((item) => String(item.nodeId) === String(parentNode.id));
    if (matching.length === 0) return undefined;
    const beforeBranch = matching.filter((item) => !isJobAfterAnchor(item, branchJob));
    return beforeBranch.length > 0 ? beforeBranch[beforeBranch.length - 1] : matching[matching.length - 1];
  };

  let currNode: FlowNodeLike | undefined = nodesById.get(String(startNode?.id ?? startJob.nodeId)) ?? startNode;
  let currJob: JobModel = startJob;
  let anchorJob: JobModel = startJob;
  const maxHops = sortedJobs.length + nodesById.size + 8;

  for (let hop = 0; hop < maxHops; hop += 1) {
    const isStartJob = String(currJob.id) === String(startJob.id);

    if (!isStartJob && Number(currJob.status) === JOB_STATUS.PENDING) {
      return { kind: 'parked' };
    }

    if (currNode?.type === 'end' && !isStartJob) {
      return { kind: 'needs_exit', status: Number(currJob.status) };
    }

    if (
      !isStartJob &&
      Number(currJob.status) === JOB_STATUS.RESOLVED &&
      (currNode?.type === 'condition' || currNode?.type === 'multi-conditions')
    ) {
      const branches = getBranchesOf(currNode, nodesById);
      let matchedBranchHead: { branch: FlowNodeLike; job: JobModel } | undefined;
      for (const b of branches) {
        const bJob = findJobAfterForNode(b.id, anchorJob, currJob);
        if (bJob) {
          matchedBranchHead = { branch: b, job: bJob };
          break;
        }
      }
      if (matchedBranchHead) {
        currNode = matchedBranchHead.branch;
        currJob = matchedBranchHead.job;
        anchorJob = maxAnchorJob(anchorJob, matchedBranchHead.job);
        continue;
      }
      if (currNode.type === 'condition') {
        const expectedBranch = branches.find((b) => Boolean(b.branchIndex) === Boolean(currJob.result));
        if (expectedBranch) {
          return { kind: 'resume_from_tail', tailNode: currNode, tailJob: currJob };
        }
      }
    }

    const downstreamId = getDownstreamId(currNode);
    if (Number(currJob.status) === JOB_STATUS.RESOLVED) {
      if (downstreamId !== null) {
        const nextJob = findJobAfterForNode(downstreamId, anchorJob, currJob);
        if (!nextJob) {
          return { kind: 'resume_from_tail', tailNode: currNode, tailJob: currJob };
        }
        currNode = nodesById.get(String(nextJob.nodeId)) ?? currNode?.downstream ?? undefined;
        currJob = nextJob;
        anchorJob = maxAnchorJob(anchorJob, nextJob);
        continue;
      }

      // Fallback when currNode metadata has no downstreamId but a direct upstreamId link exists in jobs
      const byExplicitUpstream = sortedJobs.find(
        (item) => String(item.id) !== String(currJob.id) && String(item.upstreamId ?? '') === String(currJob.id),
      );
      if (byExplicitUpstream) {
        currNode = nodesById.get(String(byExplicitUpstream.nodeId));
        currJob = byExplicitUpstream;
        anchorJob = maxAnchorJob(anchorJob, byExplicitUpstream);
        continue;
      }
    }

    const parentNode = currNode ? findBranchParent(currNode, nodesById) : null;
    if (!parentNode) {
      if (isStartJob) {
        if (consumedTokenMatches) {
          return { kind: 'needs_exit', status: Number(currJob.status) };
        }
        return { kind: 'resume_from_tail', tailNode: currNode, tailJob: currJob };
      }
      return { kind: 'needs_exit', status: Number(currJob.status) };
    }

    const parentJob = findParentScopeJob(parentNode, currJob);
    if (parentNode.type === 'parallel') {
      if (!parentJob) {
        return { kind: 'resume_from_tail', tailNode: currNode, tailJob: currJob };
      }
      const branchStart = currNode ? findBranchStart(currNode, parentNode, nodesById) : null;
      const branches = getBranchesOf(parentNode, nodesById);
      const branchPos = branchStart ? branches.findIndex((b) => String(b.id) === String(branchStart.id)) : -1;
      const recordedValue = Array.isArray(parentJob.result) && branchPos >= 0 ? parentJob.result[branchPos] : undefined;

      if (Number(parentJob.status) === JOB_STATUS.PENDING) {
        if (recordedValue !== null && recordedValue !== undefined && Number(recordedValue) !== JOB_STATUS.PENDING) {
          return { kind: 'parked' };
        }
        return { kind: 'resume_from_tail', tailNode: currNode, tailJob: currJob };
      }

      currNode = parentNode;
      currJob = parentJob;
      anchorJob = maxAnchorJob(anchorJob, parentJob);
      continue;
    }

    if (parentNode.type === 'loop') {
      if (!parentJob) {
        return { kind: 'resume_from_tail', tailNode: currNode, tailJob: currJob };
      }
      if (Number(parentJob.status) === JOB_STATUS.PENDING) {
        const branches = getBranchesOf(parentNode, nodesById);
        const loopHead = branches[0];
        const nextIterJob = loopHead ? findJobAfterForNode(loopHead.id, anchorJob) : undefined;
        if (nextIterJob) {
          currNode = loopHead;
          currJob = nextIterJob;
          anchorJob = maxAnchorJob(anchorJob, nextIterJob);
          continue;
        }
        return { kind: 'resume_from_tail', tailNode: currNode, tailJob: currJob };
      }

      currNode = parentNode;
      currJob = parentJob;
      anchorJob = maxAnchorJob(anchorJob, parentJob);
      continue;
    }

    if (parentNode.type === 'multi-conditions' && parentJob && Number(parentJob.status) === JOB_STATUS.PENDING) {
      return { kind: 'resume_from_tail', tailNode: currNode, tailJob: currJob };
    }

    if (Number(currJob.status) !== JOB_STATUS.RESOLVED) {
      // Rejected status bubbles up through Condition / MultiConditions to outer scope
      currNode = parentNode;
      anchorJob = maxAnchorJob(anchorJob, currJob);
      continue;
    }

    currNode = parentNode;
    if (parentJob) {
      currJob = parentJob;
      anchorJob = maxAnchorJob(anchorJob, parentJob);
    }
  }

  return { kind: 'resume_from_tail', tailNode: currNode, tailJob: currJob };
}
