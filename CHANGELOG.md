# Changelog

## 0.1.0 (unreleased)

The first public release.

- System 1 over the System One protocol: hosted decision models on OpenRouter or your own server (`SYSTEM1_URL`,
  `SYSTEM1_MODEL`, `SYSTEM1_API_KEY`), with typed requests and answers and each known model's limits.
- `karpo-browser run`: one goal worked by System 1 alone.
- `karpo-browser mcp`: the browser as eleven tools for a System 2 agent: `open`, `run_browser_agent`, `read_page`,
  actions by hand and `screenshot`.
- A Claude Code plugin and a skill for System 2 agents.
- The controller (`test/controller`), an optional System 2 of our own.
- Faster defaults: settles of 200/300 ms quiet and 1.5 s at most after an action (`settleQuietMs`,
  `settleNetworkQuietMs`, `actionSettleMaxMs`), 3.5 s and the fast settle after an open (`openSettleMs`,
  `fastOpenSettle`), a 150 ms wait for a step's screenshot (`screenshotGraceMs`), BACK's read with the page
  (`backWithRead`) and follow-ups in the step's request (`mergeFollowups`). Pass the old values, or `false`, to restore.
- FILL sets a slider to the value it is to show ("2:00 PM", "$500"), by the slider's own words for its value
  (`aria-valuetext`) or else its value: a native range through the element, any other slider by arrow keys. A slider
  that does not come to show the value is put back, and the step says what it holds.
- A read waits while the browser solves a verification challenge itself, as Browserbase with captcha solving on
  says in the page's console (`browserbase-solving-started`, then `-finished` or `-errored`): at most 60 s, not past a
  run's stop. SOLVE_CAPTCHA waits for that solving too and says the browser solved it. A browser that says nothing of
  the kind is read as before.
- A frame whose `<iframe>` the page hides (visibility `hidden` or `collapse`) is not read. Visibility does not pass
  into another document, so the frame's own styles said it was visible: hCaptcha's challenge, kept hidden above the
  page until it asks something, was listed under `above:` with its buttons, and System 1 took it for a challenge.
