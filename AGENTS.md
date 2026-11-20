# Working on karpo-browser

## Commands

- `npm run check`: TypeScript and Biome. `npm test`: Vitest (live tests start Chrome when the machine has one).
  `npm run build`: the npm package's `dist`.
- Node 22.18 or later runs the `.ts` files directly: `node src/cli.ts run …`, `node test/controller/cli.ts …`.

## Layout

- `src/`: System 1. The browser (`browser/`), reading pages (`reading/`), asking the decision model (`decider/`),
  runs (`run/`), the MCP server (`mcp.ts`) and the command line (`cli.ts`). `index.ts` is the public interface.
- `test/controller/`: the controller, an optional System 2. It uses only `src/index.ts`.
- `skills/karpo-browser/` and `.claude-plugin/`: what agents install.

## Rules

- A number or a string with a meaning is a named constant.
- Comments say what a thing is and why, in plain words.
- `src/profiles/default.json` holds the words the decision models are asked in: change them only with a model
  trained on the new ones.
- The MCP tools are described in four places that must agree: `src/mcp.ts` (the tools and `INSTRUCTIONS`),
  `skills/karpo-browser/SKILL.md`, the tools table in `README.md`, and the controller's own tools
  (`test/controller/tools.ts`) where they share a name.
- A version lives in `package.json` (the MCP server reads its `serverInfo.version` from there),
  `.claude-plugin/plugin.json` and `CHANGELOG.md`: change them together.
- A new or renamed setting goes into the README's configuration table and `CHANGELOG.md`.
- No runtime dependencies.
- Never commit keys, private addresses or names of internal systems.
