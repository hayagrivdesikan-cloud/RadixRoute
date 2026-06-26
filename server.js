import Fastify from 'fastify';
import AICdnNode from './aiCdnNode.js';
import 'dotenv/config';

const fastify = Fastify({ logger: true });

const primaryNode = new AICdnNode({
    nodeId: process.env.NODE_ID || 'edge-us-east-1',
    region: process.env.NODE_REGION || 'us-east'
});

const nearbyNodeA = new AICdnNode({
    nodeId: 'edge-us-central-1',
    region: 'us-central'
});

const nearbyNodeB = new AICdnNode({
    nodeId: 'edge-us-west-1',
    region: 'us-west'
});

const nodes = [primaryNode, nearbyNodeA, nearbyNodeB];

function findNode(nodeId) {
    return nodes.find((candidate) => candidate.nodeId === nodeId);
}

primaryNode.addNeighbor(nearbyNodeA);
primaryNode.addNeighbor(nearbyNodeB);
nearbyNodeA.addNeighbor(primaryNode);
nearbyNodeB.addNeighbor(primaryNode);

await Promise.all(nodes.map((node) => node.init()));

fastify.get('/health', async () => ({ ok: true, node: primaryNode.nodeId }));

fastify.get('/stats', async () => ({
    primary: primaryNode.stats(),
    neighbors: [nearbyNodeA.stats(), nearbyNodeB.stats()]
}));

fastify.get('/_admin/nodes', async () => ({
    nodes: nodes.map((node) => ({ nodeId: node.nodeId, region: node.region }))
}));

fastify.get('/_admin/qdrant-count', async () => {
    const counts = {};
    for (const node of nodes) {
        counts[node.nodeId] = await node.semanticCount();
    }
    return { counts };
});

fastify.post('/_admin/reset', async () => {
    const results = [];
    for (const node of nodes) {
        results.push(await node.clear());
    }
    return { ok: true, results };
});

fastify.post('/_admin/seed/:nodeId', async (request, reply) => {
    const node = findNode(request.params.nodeId);
    if (!node) return reply.status(404).send({ error: 'Node not found.' });

    const result = await node.handleRequest(request.body || {});
    if (result.statusCode) return reply.status(result.statusCode).send(result.body);
    return { ok: true, seededNodeId: node.nodeId, result: result.body };
});

fastify.post('/_admin/:nodeId/chat', async (request, reply) => {
    const node = findNode(request.params.nodeId);
    if (!node) return reply.status(404).send({ error: 'Node not found.' });

    const result = await node.handleRequest(request.body || {});
    if (result.statusCode) return reply.status(result.statusCode).send(result.body);
    return result.body;
});

fastify.post('/v1/chat/completions', async (request, reply) => {
    const result = await primaryNode.handleRequest(request.body || {});
    if (result.statusCode) return reply.status(result.statusCode).send(result.body);
    return result.body;
});

fastify.post('/_neighbor/:nodeId/lookup', async (request, reply) => {
    const node = findNode(request.params.nodeId);
    if (!node) return reply.status(404).send({ error: 'Node not found.' });

    const { route, embedding } = request.body || {};
    const hit = await node.lookupOnly(request.body?.payload || request.body, route, embedding);
    return hit || { hit: false };
});

const start = async () => {
    try {
        const port = Number(process.env.PORT || 3000);

        await fastify.listen({ port, host: '0.0.0.0' });
        console.log(`AI-CDN edge gateway active on port ${port}`);
    } catch (error) {
        fastify.log.error(error);
        process.exit(1);
    }
};

start();
