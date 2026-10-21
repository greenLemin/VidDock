#!/usr/bin/env node
import { HostServer } from './server.ts';

// Chrome launches this process with the extension origin as argv[2]; the stdio channel is the protocol.
const server = new HostServer(process.stdin, process.stdout);
process.on('SIGTERM', () => void server.close().then(() => process.exit(0)));
process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
void server.start().then(() => process.exit(0));
