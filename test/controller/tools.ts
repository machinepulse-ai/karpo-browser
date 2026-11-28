/**
 * The controller's tools as the model is offered them: their names, what each does, and their arguments' JSON schemas.
 * The schemas keep to what every provider's function calling takes (no free-form objects): values go as a list of
 * names and texts.
 */
import type { ToolSpec } from "./chat.ts";

export const OPEN = "open";
export const RUN = "run_browser_agent";
export const READ = "read_page";
export const SHOW = "show";
export const CLICK = "click";
export const TYPE = "type";
export const SELECT = "select";
export const PRESS_ENTER = "press_enter";
export const ESCAPE = "escape";
export const SCROLL = "scroll";
export const BACK = "back";
export const FINISH = "finish";
export const COMPARE = "compare";
/** What each page a compare read is heard as, for whoever watches the task: a tool call of its own. */
export const COMPARE_PAGE = "compare_page";
/** The fewest and the most addresses a compare takes. */
export const MIN_COMPARED = 2;
export const MAX_COMPARED = 5;

/** The tools that act on the page by hand, which a task may use only so often. */
export const MANUAL_TOOLS: ReadonlySet<string> = new Set([CLICK, TYPE, SELECT, PRESS_ENTER, ESCAPE, SCROLL, BACK]);

const ELEMENT = { type: "integer", description: "The element's number as read_page or the last result shows it." };

const VALUES = {
  type: "array",
  description:
    'Every value the goal needs typed, each under what it is for on the site, e.g. [{"name": "search", "text": "Ginza sushi"}]. Only these can be typed.',
  items: {
    type: "object",
    properties: { name: { type: "string" }, text: { type: "string" } },
    required: ["name", "text"],
  },
};

const NO_ARGUMENTS = { type: "object", properties: {} };

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: RUN,
    description:
      "Reaches a state on the site the tab is on: a decision model clicks, types, chooses and scrolls one step at a time until the page shows what the goal names, or something stops it. Answers how it ended, the latest actions, and the page as it last read it.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "The end state to reach on this site and the limits to keep, in English: the outcome, not the clicks.",
        },
        field_values: VALUES,
      },
      required: ["goal"],
    },
  },
  {
    name: OPEN,
    description: "Opens an address in the tab and answers the page's first lines.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: READ,
    description:
      "Reads the current page. With containing, counts and lists lines containing all given phrases, ignoring case. The count covers the whole loaded reading.",
    parameters: {
      type: "object",
      properties: { containing: { type: "array", minItems: 1, items: { type: "string" } } },
    },
  },
  {
    name: SHOW,
    description:
      "Brings a text of the page into view, as a person scrolls to it, so the page as seen shows it: a fact you will report. Not an action by hand.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The words or the value, as the page writes them." } },
      required: ["text"],
    },
  },
  {
    name: CLICK,
    description: "Clicks an element, by hand.",
    parameters: { type: "object", properties: { element: ELEMENT }, required: ["element"] },
  },
  {
    name: TYPE,
    description: "Types a text into a box, replacing what it holds, by hand; with enter, presses Enter after it.",
    parameters: {
      type: "object",
      properties: { element: ELEMENT, text: { type: "string" }, enter: { type: "boolean" } },
      required: ["element", "text"],
    },
  },
  {
    name: SELECT,
    description: "Chooses an option of a dropdown by its text, by hand.",
    parameters: {
      type: "object",
      properties: { element: ELEMENT, option: { type: "string" } },
      required: ["element", "option"],
    },
  },
  {
    name: PRESS_ENTER,
    description: "Presses Enter in an element, by hand.",
    parameters: { type: "object", properties: { element: ELEMENT }, required: ["element"] },
  },
  { name: ESCAPE, description: "Presses Escape on the page, by hand.", parameters: NO_ARGUMENTS },
  {
    name: SCROLL,
    description: "Scrolls the page, or a scroll area given by its element, down or up by a screen, by hand.",
    parameters: {
      type: "object",
      properties: { direction: { type: "string", enum: ["down", "up"] }, element: ELEMENT },
      required: ["direction"],
    },
  },
  { name: BACK, description: "Goes back to the page before, by hand.", parameters: NO_ARGUMENTS },
  {
    name: FINISH,
    description: "Ends the task with its answer.",
    parameters: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
  },
];

/** The one tool left when the browser may take no more actions. */
export const FINISH_ONLY: readonly ToolSpec[] = TOOL_SPECS.filter((tool) => tool.name === FINISH);

/** show as offered when it takes several texts at once: each is brought into view in turn. */
const MULTI_SHOW = {
  description:
    "Brings texts of the page into view one after another, as a person scrolls to each, so the page as seen shows each of them: the facts you will report. Not an action by hand.",
  parameters: {
    type: "object",
    properties: {
      texts: {
        type: "array",
        description: "The words or the values, as the page writes them, in the order to show them.",
        items: { type: "string" },
      },
    },
    required: ["texts"],
  },
};

/** compare, offered when it is chosen. */
const COMPARE_SPEC: ToolSpec = {
  name: COMPARE,
  description: `Opens ${MIN_COMPARED} to ${MAX_COMPARED} addresses at once, each in a background tab of its own, and answers each page's title, address and lines (with look_for, the lines around it first); the tab in front stays as it is. Each page counts as one action on the browser.`,
  parameters: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        description: `The addresses of the pages to compare, ${MIN_COMPARED} to ${MAX_COMPARED}, each a web address (http or https).`,
        items: { type: "string" },
      },
      look_for: {
        type: "string",
        description:
          "Words or a value to find on each page, as the pages write them: the lines around them come first.",
      },
    },
    required: ["urls"],
  },
};

/** open's description when it answers with the page as read_page gives it. */
const FULL_OPEN_DESCRIPTION = "Opens an address in the tab and answers the page as read_page gives it.";

/** How show and open are offered. */
export interface SpecChoices {
  /** show takes several texts. */
  multiShow?: boolean | undefined;
  /** open answers with the page as read_page gives it, not its first lines. */
  openFullPage?: boolean | undefined;
  /** compare is offered, after read_page. */
  compare?: boolean | undefined;
}

/** The tools with show and open as the choices offer them, and compare when it is chosen. */
export function chosenSpecs(specs: readonly ToolSpec[], choices: SpecChoices): readonly ToolSpec[] {
  return specs.flatMap((tool) => {
    if (tool.name === SHOW && choices.multiShow) return [{ ...tool, ...MULTI_SHOW }];
    if (tool.name === OPEN && choices.openFullPage) return [{ ...tool, description: FULL_OPEN_DESCRIPTION }];
    if (tool.name === READ && choices.compare) return [tool, COMPARE_SPEC];
    return [tool];
  });
}
