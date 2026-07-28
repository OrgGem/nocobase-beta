#!/usr/bin/env node
import process from 'node:process';

const [,, command, clientName, propertyName, methodName, raw] = process.argv;
const baseUrl = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const pat = process.env.JIRA_PAT;
if (!baseUrl || !pat) throw new Error('Set JIRA_BASE_URL and JIRA_PAT');
const jira = await import('jira.js');
const configs = { host: baseUrl, noCheckAtlassianToken: true, baseRequestConfig: { headers: { Authorization: `Bearer ${pat}` } } };
const clients = { version3: new jira.Version3Client(configs), version2: new jira.Version2Client(configs), agile: new jira.AgileClient(configs), serviceDesk: new jira.ServiceDeskClient(configs) };
if (command === 'list') {
  if (clientName && propertyName) {
    const target = clients[clientName]?.[propertyName];
    if (!target) throw new Error(`Unknown API group: ${clientName}.${propertyName}`);
    console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(target)).filter((key) => key !== 'constructor' && typeof target[key] === 'function').join('\n'));
    process.exit(0);
  }
  for (const [name, client] of Object.entries(clients)) console.log(`${name}: ${Object.keys(client).filter((key) => typeof client[key] === 'object').join(', ')}`);
  process.exit(0);
}
if (command !== 'call' || !clients[clientName] || !propertyName || !methodName) throw new Error('Usage: call <version3|version2|agile|serviceDesk> <property> <method> <json|->');
const target = clients[clientName][propertyName];
if (!target || typeof target[methodName] !== 'function') throw new Error(`Unknown API method: ${clientName}.${propertyName}.${methodName}`);
const input = raw === '-' ? JSON.parse(await new Promise((resolve, reject) => { let s=''; process.stdin.on('data', c => { s += c; }); process.stdin.on('end', () => resolve(s)); process.stdin.on('error', reject); })) : JSON.parse(raw || '{}');
const result = await target[methodName](input);
console.log(JSON.stringify(result, null, 2));
