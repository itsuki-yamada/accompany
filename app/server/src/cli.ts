#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { app } from "./app";

const { values } = parseArgs({
  options: { port: { type: "string", default: "3000" } },
});

const server = Bun.serve({ port: Number(values.port), fetch: app.fetch });

console.log(`Accompany: http://localhost:${server.port}`);
