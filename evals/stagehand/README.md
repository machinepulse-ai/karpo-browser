# Browserbase Benchmark v2 with Stagehand's eval harness

How to run karpo-browser on Browserbase Benchmark v2 (HardBench: 102 tasks on live sites, each judged by its own
rubric) with Stagehand's open-source eval harness, using the current benchmark preset: the controller in
`test/controller` as System 2 and a decision model as System 1, with the configuration in
`test/controller/benchmark.ts`, except that System 2's provider is left to OpenRouter. Ours was served by a single
provider; with another, speed and cost differ.

| File                      | What it is                                                                        |
| ------------------------- | --------------------------------------------------------------------------------- |
| `stagehand.patch`         | Adds the `karpo_browser` harness to Stagehand's eval harness, at the commit below |
| `LICENSE-stagehand`       | Stagehand's MIT license, which `stagehand.patch` is under                         |
| `agent.sh`, `agent.ts`    | The program the harness starts for each task: `agent.sh` starts `agent.ts`        |
| `events.ts`               | What the program tells the harness of each step and call, and what it hides       |
| `summary.ts`              | A run's results: each task's verdict, process score and time, and the totals      |
| `hardbench-core.txt`      | The 38 tasks of the core set                                                      |
| `hardbench-no-amazon.txt` | For a run that leaves amazon.com out: the 99 tasks besides the three that use it  |

## What you need

- Node 24 or later (Stagehand's eval harness asks for it; the agent itself needs 22.18 or later, which runs its `.ts`
  files as they are), pnpm (Stagehand builds with 11.11) and git.
- A Browserbase account: its API key and project id. The harness opens each task's browser with Browserbase's
  Verified browsers and proxies, which are paid features. `EVAL_BROWSERBASE_VERIFIED=0` and
  `EVAL_BROWSERBASE_PROXIES=0` turn them off; more sites will then turn the browser away, and the results will differ.
- An OpenRouter key, for System 2 and for the harness's judge.
- A System One endpoint for System 1: a decision model you serve, or one on OpenRouter (see "System 1 models" in the
  main README). Our results used Karpo Decision 27B Act on our own GPUs.
- A machine in or near us-west-2 to run the harness on, where Browserbase opens sessions by default (see "What the
  results depend on"). Leave `BROWSERBASE_REGION` unset: the agent connects through Browserbase's default connect
  address, which reached sessions in us-west-2 but not one opened in ap-southeast-1 when we tried.

## Steps

1. Stagehand at the commit the patch is made for, with the harness added and its command line built. The patch
   applies to that commit only.

   ```bash
   git clone https://github.com/browserbase/stagehand.git
   cd stagehand
   git checkout c8e096cb83b6c06ad73e49583fb79a87e78bdd3c
   git apply /path/to/karpo-browser/evals/stagehand/stagehand.patch
   pnpm install --frozen-lockfile
   pnpm build:cli
   ```

2. A clone of this repository. There is nothing to install: Node runs the agent from the clone.

   ```bash
   git clone https://github.com/machinepulse-ai/karpo-browser.git
   ```

3. The settings, in the shell you run the harness from:

   ```bash
   # Browserbase
   export BROWSERBASE_API_KEY=bb_live_... BROWSERBASE_PROJECT_ID=...
   # The judge: Gemini 3.5 Flash on OpenRouter, through the harness's OpenAI-compatible provider
   export OPENAI_API_KEY=sk-or-... OPENAI_BASE_URL=https://openrouter.ai/api/v1
   export EVAL_VERIFIER_MODEL=openai/google/gemini-3.5-flash
   # The agent: its absolute path, System 1 and System 2's key
   export EVAL_AGENT_BIN=/path/to/karpo-browser/evals/stagehand/agent.sh
   export SYSTEM1_URL=https://your-server/v1/systemone SYSTEM1_MODEL=karpo-decision-27b-act SYSTEM1_API_KEY=...
   export SYSTEM2_API_KEY=sk-or-...
   # Where the trajectories and scores go
   export EVAL_TRAJECTORY_ROOT=$HOME/hardbench-runs
   # The harness runs at most 3 tasks of one model provider at once unless told more; the agent's is "karpo-browser"
   export EVAL_PROVIDER_CONCURRENCY=karpo-browser=4
   ```

   Optional:

   | Variable                 | Meaning                                                            | Default                                                 |
   | ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------- |
   | `SYSTEM2_MODEL`          | System 2: a preset of `test/controller/models.ts`, or any model id | DeepSeek V4.1 Flash on OpenRouter, as in `benchmark.ts` |
   | `SYSTEM2_BASE_URL`       | System 2's OpenAI-compatible endpoint                              | OpenRouter's                                            |
   | `EVAL_AGENT_MAX_STEPS`   | The tool calls a task may make (each step on the page is one)      | 100, HardBench's                                        |
   | `EVAL_AGENT_RUN_SECONDS` | The time the harness gives a task                                  | 2400; the agent answers within 450 s anyway             |

   Leave `SYSTEM2_MODEL` unset to run the benchmark's System 2: a value left over from the main README's controller
   example replaces it.

   An exported `AGENT_EVAL_MAX_STEPS`, which the harness reads for every agent, also replaces HardBench's 100 tool
   calls (`EVAL_AGENT_MAX_STEPS` wins over it). With fewer than 12 tool calls, System 1 gets no run: the agent keeps 9
   for its first call, the evidence and a reserve, and a run of System 1 needs 3.

   If `CI` is set, the harness keeps no trajectories (`VERIFIER_PERSIST_TRAJECTORIES=1` keeps them), and `summary.ts`
   finds nothing.

4. The run, from the Stagehand checkout. `--harness karpo_browser` starts the agent for each task, `--tool
   stagehand_facade` gives it the harness's browser tool (the agent calls it once, so the harness records the page),
   `-e browserbase` opens each task in a Browserbase session, `-t 1` runs each task once, `-c 4` runs four at once.
   With `-c 4`, four tasks ask System 1 at once; a server with a single replica answers them in turn, and decisions
   take longer.

   ```bash
   # The core set, 38 tasks (the harness's default set)
   EVAL_HARDBENCHMARK_SET=core node packages/evals/dist/cli/cli.js run b:hardbenchmark \
     --harness karpo_browser --tool stagehand_facade -e browserbase -t 1 -c 4

   # All 102 tasks
   EVAL_HARDBENCHMARK_SET=extended node packages/evals/dist/cli/cli.js run b:hardbenchmark \
     --harness karpo_browser --tool stagehand_facade -e browserbase -t 1 -c 4

   # The tasks of a list, by their ids: here the 99 without amazon.com
   EVAL_HARDBENCHMARK_IDS=$(paste -sd, /path/to/karpo-browser/evals/stagehand/hardbench-no-amazon.txt) \
     node packages/evals/dist/cli/cli.js run b:hardbenchmark \
     --harness karpo_browser --tool stagehand_facade -e browserbase -t 1 -c 4
   ```

   Ids given in `EVAL_HARDBENCHMARK_IDS` are run whatever the set says.

5. The results:

   ```bash
   node /path/to/karpo-browser/evals/stagehand/summary.ts $EVAL_TRAJECTORY_ROOT
   ```

   It prints each run under the directory (or the one run whose directory you give) as a table, then its totals:

   ```
   agent_hardbenchmark__karpo-browser_controller__20261120-193249-dbc1faf4854b6554
   task              verdict     process  agent time
   06189d67b34ea559  passed         1.00     102.4 s
   9c5c1a8626aac06e  passed         0.83      95.8 s
   bd0c3683ba7b6b6e  passed         1.00      99.5 s
   passed: 3 of 3 graded (100%), 3 tasks
   process score: 0.94 on average
   agent time: 99.2 s on average, 99.5 s median (3 tasks)
   ```

## Where the results are

Each run of the harness is a directory of `EVAL_TRAJECTORY_ROOT`, and each task one of the run's:
`<run>/<task id>/<time>/`.

- `scores/result.json`: the judge's verdict. `outcomeSuccess` is whether the task passed, `processScore` (0 to 1) how
  much of its rubric was met, `perCriterion` each criterion with the judge's reason.
- `trajectory.json`: the task, every step the harness saw and the final answer; `screenshots/` the pages.
- `agent/karpo-browser-run.json`: the agent's own record: its configuration, System 2's turns, actions by hand and
  tokens, System 1's runs and each of its decisions' time, the browser's settles, and the report.
- `<run>/logs/`: each task's log. Its `timing · agent=…` line is the agent's time, judging and the harness's own
  captures not included: the time `summary.ts` gives.

## What the agent does

The harness starts `agent.sh` for each task with the task on its standard input and the task's Browserbase session in
`BROWSERBASE_SESSION_ID`. The agent connects to that session itself, calls the harness's browser tool once (the harness
records the page only once the agent has called a tool), opens the start page and has the controller work the task.
Each step of System 1, and each call of System 2's that reads or acts on the page, is told to the harness as a tool
call: the harness records the page after it, and the call counts against the tool-call budget, which the agent keeps.
System 1's steps and the values System 2
shows carry the agent's own screenshot as well, for the judge. So that the judge has what the controller saw, the
agent tells two more things as tool calls: the start page as System 2 read it, and at most 6 pages System 1 judged
done, each with its screenshot. The answer is due 450 s after the start: our setting (`BENCHMARK_DEADLINE_S` in
`test/controller/benchmark.ts`), as HardBench sets no deadline and the harness gives a task 2400 s. Keys are left out
of everything the agent writes, and so is System 1's address as `SYSTEM1_URL` gives it, with its host and port. A host
name shorter than 8 characters is hidden only as part of the address, and other forms that a connection error may
quote, such as the IP address the host name resolves to, are not hidden.

The current preset asks the controller to check its first proposed answer against the task when time and browser actions allow. Earlier published runs used a preset without this check.

## What the results depend on

- **System 1**: another decision model, or the same one served elsewhere (slower or faster), gives other results.
- **System 2**: another model, or another OpenRouter provider of the same one, gives other results. OpenRouter picks
  the provider here; a single one served our runs.
- **Where the harness runs**: the agent reads the page through the Browserbase session many times a step, so run the
  harness near the sessions, which Browserbase opens in us-west-2; our runs were on a machine in the same region. With
  the same three tasks and the same models, a task took 96 to 102 s from us-west-2, each read of the page 0.09 to
  0.27 s; from a machine on another continent, 257 to 401 s, each read 3.8 to 15 s, close to the 450 s deadline.
- **The sites**: the tasks run on live sites, which change, slow down and sometimes turn a browser away.
- **The browser**: Browserbase's Verified browsers and proxies, which the harness turns on.
- **The judge**: a model too. Scores from another judge are not comparable.
- **Chance**: models are not deterministic and sites vary, so one configuration scores differently from one run to the
  next. Compare configurations over several runs, not one.

## License

`stagehand.patch` is a change to Stagehand and, like the code it adapts, is under Stagehand's MIT license
([LICENSE-stagehand](LICENSE-stagehand)). The other files here are under this repository's Apache License 2.0.
