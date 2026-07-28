#!/usr/bin/env node
import process from 'node:process';

const [,, command, clientName, propertyName, methodName, raw] = process.argv;
const baseUrl = (process.env.CONFLUENCE_BASE_URL || '').replace(/\/$/, '');
const pat = process.env.CONFLUENCE_PAT;
if (!baseUrl || !pat) throw new Error('Set CONFLUENCE_BASE_URL and CONFLUENCE_PAT');
const confluence = await import('confluence.js');
const config = { host: baseUrl, auth: { type: 'bearer', token: pat } };
const clients = { v1: confluence.createV1Client(config), v2: confluence.createV2Client(config) };
if (command === 'list') {
  if (clientName && propertyName) {
    const target = clients[clientName]?.[propertyName];
    if (!target) throw new Error(`Unknown API group: ${clientName}.${propertyName}`);
    console.log(Object.keys(target).filter((key) => typeof target[key] === 'function').join('\n'));
    process.exit(0);
  }
  for (const [name, client] of Object.entries(clients)) console.log(`${name}: ${Object.keys(client).filter((key) => typeof client[key] === 'object').join(', ')}`);
  process.exit(0);
}
if (command !== 'call' || !clients[clientName] || !propertyName || !methodName) throw new Error('Usage: call <v1|v2> <property> <method> <json|->');
const target = clients[clientName][propertyName];
if (!target || typeof target[methodName] !== 'function') throw new Error(`Unknown API method: ${clientName}.${propertyName}.${methodName}`);
const input = raw === '-' ? JSON.parse(await new Promise((resolve, reject) => { let s=''; process.stdin.on('data', c => { s += c; }); process.stdin.on('end', () => resolve(s)); process.stdin.on('error', reject); })) : JSON.parse(raw || '{}');
const result = await target[methodName](input);
console.log(JSON.stringify(result, null, 2));
