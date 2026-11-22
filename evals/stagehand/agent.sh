#!/bin/sh
# The program the harness starts for each task (EVAL_AGENT_BIN names this file): agent.ts, which Node 22.18 or later
# runs as it is.
exec node "$(cd "$(dirname "$0")" && pwd)/agent.ts"
