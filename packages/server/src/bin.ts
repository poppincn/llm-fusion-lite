#!/usr/bin/env node
import { startServer } from "./server.js";

const { port } = startServer();
console.log(`\n  LLM Fusion Lite server → http://localhost:${port}`);
console.log(`  OpenAI-compatible endpoint: http://localhost:${port}/v1\n`);
