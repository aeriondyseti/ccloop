#!/usr/bin/env bun
import { run } from "./cli/dispatch.ts";

const exitCode = await run(process.argv.slice(2));
process.exit(exitCode);
