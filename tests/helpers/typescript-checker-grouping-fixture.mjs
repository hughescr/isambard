import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const checkerRoot = path.dirname(require.resolve('@stryker-mutator/typescript-checker/package.json'));
const { createGroups } = await import(pathToFileURL(path.join(checkerRoot, 'dist/src/grouping/create-groups.js')).href);

class CountingNode {
    calls = 0;

    constructor(fileName, parents = []) {
        this.fileName = fileName;
        this.parents = parents;
    }

    getAllParentReferencesIncludingSelf(allParents = new Set()) {
        this.calls += 1;
        allParents.add(this);
        for(const parent of this.parents) {
            if(!allParents.has(parent)) {
                parent.getAllParentReferencesIncludingSelf(allParents);
            }
        }
        return allParents;
    }
}

function referenceCreateGroups(mutants, nodes) {
    const groups = [];
    const remaining = new Set(mutants);
    while(remaining.size > 0) {
        const group = [];
        const groupNodes = new Set();
        const nodesToIgnore = new Set();
        for(const mutant of remaining) {
            const node = nodes.get(mutant.fileName);
            if(node === undefined) {
                throw new Error(`Node not in graph: ${mutant.fileName}`);
            }
            if(!nodesToIgnore.has(node) && ![...node.getAllParentReferencesIncludingSelf()].some(parent => groupNodes.has(parent))) {
                group.push(mutant.id);
                groupNodes.add(node);
                remaining.delete(mutant);
                for(const parent of node.getAllParentReferencesIncludingSelf()) {
                    nodesToIgnore.add(parent);
                }
            }
        }
        groups.push(group);
    }
    return groups;
}

function buildGraph() {
    const root = new CountingNode('root.ts');
    const shared = new CountingNode('shared.ts', [root]);
    const a = new CountingNode('a.ts', [shared]);
    const b = new CountingNode('b.ts', [shared]);
    const cycleA = new CountingNode('cycle-a.ts');
    const cycleB = new CountingNode('cycle-b.ts', [cycleA]);
    cycleA.parents.push(cycleB);
    const isolated = new CountingNode('isolated.ts');
    const nodes = new Map([root, shared, a, b, cycleA, cycleB, isolated].map(node => [node.fileName, node]));
    const mutants = [
        { id: 'a-1', fileName: 'a.ts' },
        { id: 'a-2', fileName: 'a.ts' },
        { id: 'b-1', fileName: 'b.ts' },
        { id: 'cycle-a', fileName: 'cycle-a.ts' },
        { id: 'cycle-b', fileName: 'cycle-b.ts' },
        { id: 'isolated', fileName: 'isolated.ts' },
    ];
    return { nodes, mutants };
}

const referenceGraph = buildGraph();
const actualGraph = buildGraph();
assert.deepEqual(createGroups(actualGraph.mutants, actualGraph.nodes), referenceCreateGroups(referenceGraph.mutants, referenceGraph.nodes), 'cached grouping changed exact nested ID order for cycles, shared parents, disconnected nodes, or same-file mutants');

function graphChangeGroups(grouping) {
    const left = new CountingNode('left.ts');
    const right = new CountingNode('right.ts');
    const nodes = new Map([[left.fileName, left], [right.fileName, right]]);
    const mutants = [{ id: 'left', fileName: left.fileName }, { id: 'right', fileName: right.fileName }];
    assert.deepEqual(grouping(mutants, nodes), [['left', 'right']]);
    right.parents.push(left);
    return grouping(mutants, nodes);
}
assert.deepEqual(graphChangeGroups(createGroups), [['left'], ['right']], 'call-local cache leaked across graph changes');
assert.deepEqual(graphChangeGroups(referenceCreateGroups), [['left'], ['right']], 'reference graph-change contract changed');

assert.throws(() => createGroups([{ id: 'missing', fileName: 'missing.ts' }], new Map()), /Node not in graph: missing\.ts/);

function oneNodeCase(mutantCount) {
    const node = new CountingNode('hot.ts');
    return {
        nodes:   new Map([[node.fileName, node]]),
        node,
        mutants: Array.from({ length: mutantCount }, (_, index) => ({ id: `m-${index}`, fileName: node.fileName })),
    };
}

const referenceHot = oneNodeCase(1000);
const referenceStart = performance.now();
const referenceGroups = referenceCreateGroups(referenceHot.mutants, referenceHot.nodes);
const referenceElapsedMs = performance.now() - referenceStart;
const cachedHot = oneNodeCase(1000);
const cachedStart = performance.now();
const cachedGroups = createGroups(cachedHot.mutants, cachedHot.nodes);
const cachedElapsedMs = performance.now() - cachedStart;
assert.deepEqual(cachedGroups, referenceGroups, 'cached hot-path grouping changed output');
assert.equal(referenceHot.node.calls, 2000, 'uncached call-count control changed');
assert.equal(cachedHot.node.calls, 1, 'cached traversal should compute one ancestor set per node per call');

function deepGraphCase(depth, mutantCount) {
    const nodes = [];
    for(let index = 0; index < depth; index += 1) {
        nodes.push(new CountingNode(`deep-${index}.ts`, index === 0 ? [] : [nodes[index - 1]]));
    }
    const target = nodes.at(-1);
    assert.ok(target);
    return {
        nodes:    new Map(nodes.map(node => [node.fileName, node])),
        allNodes: nodes,
        mutants:  Array.from({ length: mutantCount }, (_, index) => ({ id: `deep-${index}`, fileName: target.fileName })),
    };
}

function traversalCalls(nodes) {
    return nodes.reduce((total, node) => total + node.calls, 0);
}

const referenceDeep = deepGraphCase(64, 250);
const referenceDeepStart = performance.now();
const referenceDeepGroups = referenceCreateGroups(referenceDeep.mutants, referenceDeep.nodes);
const referenceDeepElapsedMs = performance.now() - referenceDeepStart;
const cachedDeep = deepGraphCase(64, 250);
const cachedDeepStart = performance.now();
const cachedDeepGroups = createGroups(cachedDeep.mutants, cachedDeep.nodes);
const cachedDeepElapsedMs = performance.now() - cachedDeepStart;
assert.deepEqual(cachedDeepGroups, referenceDeepGroups, 'cached deep-path grouping changed output');
assert.equal(traversalCalls(referenceDeep.allNodes), 32_000, 'uncached deep traversal control changed');
assert.equal(traversalCalls(cachedDeep.allNodes), 64, 'cached deep traversal should visit the ancestor chain once');

process.stdout.write(`${JSON.stringify({
    cachedAncestorCalls:         cachedHot.node.calls,
    referenceAncestorCalls:      referenceHot.node.calls,
    cachedElapsedMs,
    referenceElapsedMs,
    cachedDeepTraversalCalls:    traversalCalls(cachedDeep.allNodes),
    referenceDeepTraversalCalls: traversalCalls(referenceDeep.allNodes),
    cachedDeepElapsedMs,
    referenceDeepElapsedMs,
})}\n`);
