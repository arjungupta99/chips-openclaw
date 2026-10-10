/**
 * An agent's model and effort in Chips (Chips ADR 0140): what each of our agents runs on in
 * OpenClaw and how hard it thinks, sent to Chips as a copy so a person sees it on the agent's page,
 * and a person's change there written into the agent's entry in OpenClaw's config.
 *
 * OpenClaw keeps both per agent: its model (`agents.entries.<id>.model`) and its thinking level
 * (`agents.entries.<id>.thinkingDefault`). An agent that sets neither runs on `agents.defaults`, and
 * at the model's own level when the defaults set none. `agents.list` says what each agent runs on
 * now, worked out; the config says whether that is its own. `models.list` with `view: "configured"`
 * names the models this install offers, each with its thinking levels, lowest first (8 October
 * 2026: six, all on Codex; the `default` view adds three with no levels at all, which the
 * install's own picker leaves out).
 *
 * A change is one `config.patch` of the agent's entry, model and level together, with the hash of
 * the config it was read from: one write, so both land or neither, and one reload, which OpenClaw
 * takes in hot (`agents.entries` is a hot path in its reload plan; no gateway restart). A turn
 * starting as it is taken in can fail, and the bridge sends such a turn again once (`bridge.ts`).
 * `null` takes the agent's own away, so it runs on the defaults again.
 *
 * The agents the bridge made are changed from Chips, and so is the primary agent, which is the
 * Main agent in Chips (its heartbeat is set from Chips too, ADR 0143). Any agent the bridge found
 * in OpenClaw is OpenClaw's: its copy says so, and Chips shows it read only.
 *
 * Chips holds no model's name: every label here is OpenClaw's, or this module's for its levels.
 */

import type { ClawPort } from "./bridge.ts";

type Payload = Record<string, unknown>;

/** What Chips takes at most (`MODEL_CHOICES_MAX`, `EFFORT_LEVELS_MAX`). */
export const MODEL_CHOICES_MAX = 40;
export const EFFORT_LEVELS_MAX = 8;
/** How long a refusal's words may be in Chips. */
const MESSAGE_MAX = 300;

/** Why an agent the bridge found in OpenClaw can't be changed from Chips (the plan's ruling 11). */
export const READ_ONLY_WHY = "OpenClaw's own agent. Change it in OpenClaw.";
/** What the Same as switch says for an agent with no model of its own. */
export const DEFAULT_LABEL = "OpenClaw's default";

/** OpenClaw's thinking levels, as a bar says them; another is said as OpenClaw spells it, capitalised. */
const LEVEL_WORDS: Readonly<Record<string, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

/** One level of a model, as the gateway lists it. */
interface ClawLevel {
  readonly id: string;
  readonly label?: string;
}

/** One model, as `models.list` gives it. */
export interface ClawModel {
  readonly id: string;
  readonly name?: string;
  readonly provider?: string;
  readonly available?: boolean;
  readonly thinkingLevels?: readonly ClawLevel[];
  readonly thinkingDefault?: string;
}

/** One agent, as `agents.list` gives it: what it runs on now, worked out. */
export interface ListedAgent {
  readonly id: string;
  readonly model?: { readonly primary?: string };
  readonly thinkingLevels?: readonly ClawLevel[];
  readonly thinkingDefault?: string;
}

/** A model as the config sets it: `provider/id`, or with fallbacks. */
type ConfigModel = string | { readonly primary?: string } | undefined;

/** What the config sets for an agent, or for every agent (`agents.defaults`). */
export interface ClawSetting {
  readonly model?: ConfigModel;
  readonly thinkingDefault?: string;
}

/**
 * Whose an agent is, as the bridge sees it: the OpenClaw agent, and whether Chips may change it,
 * which it may for one the bridge made and for the primary agent.
 */
export interface Whose {
  readonly clawAgent: string;
  readonly changeable: boolean;
}

/** What a copy says of a person's change: made, or not and why. */
export type Answer =
  | { readonly answers: string }
  | { readonly refuses: { readonly change_id: string; readonly message?: string } };

/** The `model.change` frame Chips sends down the socket (Chips ADR 0140). */
export interface ChangeFrame {
  readonly change_id: string;
  readonly agent_id: string;
  readonly model: string | null;
  readonly effort: string | null;
}

interface Choice {
  readonly id: string;
  readonly label: string;
  readonly efforts: readonly { readonly id: string; readonly label: string }[];
  readonly effort_default?: string;
}

const primaryOf = (model: ConfigModel): string | undefined => (typeof model === "string" ? model : model?.primary);

/** A model's id as OpenClaw's config names it: `openai/gpt-6-astra`. */
const refOf = (model: ClawModel): string =>
  model.provider === undefined || model.id.includes("/") ? model.id : `${model.provider}/${model.id}`;

/** What a level's bar says. */
export function levelWords(level: ClawLevel): string {
  const known = LEVEL_WORDS[level.id];
  if (known !== undefined) return known;
  const words = level.label?.trim() || level.id;
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 40);
}

/** A model's levels as Chips takes them: each once, lowest first, its highest eight. */
function levelsOf(levels: readonly ClawLevel[] | undefined): Choice["efforts"] {
  const seen = new Set<string>();
  const each = (levels ?? []).filter((level) => !seen.has(level.id) && seen.add(level.id));
  return each.slice(-EFFORT_LEVELS_MAX).map((level) => ({ id: level.id, label: levelWords(level) }));
}

function choiceOf(id: string, label: string, levels: readonly ClawLevel[] | undefined, fallback?: string): Choice {
  const efforts = levelsOf(levels);
  return {
    id,
    label: label.slice(0, 80),
    efforts,
    ...(efforts.some((level) => level.id === fallback) ? { effort_default: fallback } : {}),
  };
}

/** A level that is one of the model's, or nothing. */
const fitting = (choice: Choice | undefined, effort: string | undefined): string | undefined =>
  choice?.efforts.some((level) => level.id === effort) === true ? effort : undefined;

/** Forty at most, the ones in `keep` always among them, in OpenClaw's order. */
function capped(choices: readonly Choice[], keep: ReadonlySet<string>): Choice[] {
  let others = MODEL_CHOICES_MAX - choices.filter((choice) => keep.has(choice.id)).length;
  return choices.filter((choice) => keep.has(choice.id) || others-- > 0);
}

/**
 * One agent's copy, whole, as Chips takes it (`PUT /v1/agents/:id/model`): the model and level it
 * runs on now, whether either is its own, OpenClaw's default for it, and the models it may run on.
 * A model it runs on that the install doesn't offer is among its choices anyway, as is the
 * default's, so the copy always names what is true.
 */
export function copyOf(input: {
  readonly agent: ListedAgent;
  readonly own: ClawSetting | undefined;
  readonly defaults: ClawSetting | undefined;
  readonly models: readonly ClawModel[];
  readonly editable: boolean;
}): Payload | undefined {
  const { agent, own, defaults } = input;
  const choices: Choice[] = [];
  const add = (choice: Choice): void => {
    if (!choices.some((each) => each.id === choice.id)) choices.push(choice);
  };
  for (const model of input.models) {
    if (model.available !== false) add(choiceOf(refOf(model), model.name ?? model.id, model.thinkingLevels, model.thinkingDefault));
  }
  const fallbackModel = primaryOf(defaults?.model);
  const model = agent.model?.primary ?? fallbackModel;
  if (model === undefined) return undefined;
  const bare = (id: string): string => id.slice(id.indexOf("/") + 1);
  add(choiceOf(model, bare(model), agent.thinkingLevels));
  if (fallbackModel !== undefined) add(choiceOf(fallbackModel, bare(fallbackModel), undefined));
  const find = (id: string | undefined): Choice | undefined => choices.find((choice) => choice.id === id);

  const effort = fitting(find(model), agent.thinkingDefault);
  const fallback = find(fallbackModel);
  const fallbackEffort = fitting(fallback, defaults?.thinkingDefault ?? fallback?.effort_default);
  return {
    model,
    ...(effort === undefined ? {} : { effort }),
    own: primaryOf(own?.model) !== undefined || own?.thinkingDefault !== undefined,
    ...(fallbackModel === undefined
      ? {}
      : {
          default: {
            label: DEFAULT_LABEL,
            model: fallbackModel,
            ...(fallbackEffort === undefined ? {} : { effort: fallbackEffort }),
          },
        }),
    choices: capped(choices, new Set([model, ...(fallbackModel === undefined ? [] : [fallbackModel])])),
    editable: input.editable,
    ...(input.editable ? {} : { why_read_only: READ_ONLY_WHY }),
  };
}

/** The patch a change is: the agent's own model and level, or `null` for each to go. */
export function patchOf(clawAgent: string, frame: Pick<ChangeFrame, "model" | "effort">): string {
  return JSON.stringify({ agents: { entries: { [clawAgent]: { model: frame.model, thinkingDefault: frame.effort } } } });
}

/** OpenClaw refusing a write because the config moved since it was read: read it again and retry. */
const MOVED = /config changed since last load/;
const WRITE_TRIES = 3;
/**
 * How long, and how often, a copy answering a change is read again until OpenClaw lists the agent
 * as changed. `config.patch` answers once the change is applied, so the first read should say so.
 */
const APPLIED_TRIES = 10;
const APPLIED_EVERY_MS = 200;

/** Whether a copy shows a change made: the model and level asked for as its own, or none of its own. */
export function shows(body: Payload, frame: Pick<ChangeFrame, "model" | "effort">): boolean {
  if (frame.model === null) return body["own"] === false;
  return body["own"] === true && body["model"] === frame.model && (frame.effort === null || body["effort"] === frame.effort);
}

/**
 * The copies Chips holds of our agents' models, kept current: each read from OpenClaw and sent when
 * it is not what was sent last, or when it answers a change. One agent's reads and sends go one
 * after another, so a later copy never lands before an earlier one.
 */
export class Models {
  /** What was sent last for each agent. */
  private readonly sent = new Map<string, string>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly claw: ClawPort,
    private readonly put: (agentId: string, body: Payload) => Promise<void>,
    private readonly log: (message: string) => void,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
  ) {}

  /** An agent's copy as OpenClaw has it now, or nothing when OpenClaw doesn't list the agent. */
  async read(whose: Whose): Promise<Payload | undefined> {
    const listed = await this.claw.request<{ agents?: ListedAgent[] }>("agents.list", {});
    const agent = listed.agents?.find((each) => each.id === whose.clawAgent);
    if (agent === undefined) return undefined;
    const config = await this.claw.request<{ config?: { agents?: { defaults?: ClawSetting; entries?: Record<string, ClawSetting> } } }>(
      "config.get",
      {},
    );
    const offered = await this.claw.request<{ models?: ClawModel[] }>("models.list", {
      agentId: whose.clawAgent,
      view: "configured",
    });
    return copyOf({
      agent,
      own: config.config?.agents?.entries?.[whose.clawAgent],
      defaults: config.config?.agents?.defaults,
      models: offered.models ?? [],
      editable: whose.changeable,
    });
  }

  /**
   * One of our agents' copy, sent if it moved since the last, or to answer a change: once it shows
   * the change `made`, or after a few reads, as it is.
   */
  agent(agentId: string, whose: Whose, answer?: Answer, made?: ChangeFrame): Promise<void> {
    return this.queue(agentId, async () => {
      let body = await this.read(whose);
      for (let tries = 1; made !== undefined && body !== undefined && !shows(body, made) && tries < APPLIED_TRIES; tries += 1) {
        await this.sleep(APPLIED_EVERY_MS);
        body = await this.read(whose);
      }
      if (body === undefined) {
        this.log(`chips: no model sent for ${agentId}: OpenClaw doesn't list ${whose.clawAgent}`);
        return;
      }
      const print = JSON.stringify(body);
      if (answer === undefined && this.sent.get(agentId) === print) return;
      await this.put(agentId, { ...body, ...answer });
      this.sent.set(agentId, print);
    });
  }

  /**
   * A person's change from Chips: written into the agent's entry, then answered by the copy as it
   * is now. An agent Chips may not change is refused, as is any write OpenClaw refuses, with
   * its words; the copy beside the refusal says what the agent still runs on.
   */
  async change(frame: ChangeFrame, whose: Whose): Promise<void> {
    let answer: Answer;
    let made: ChangeFrame | undefined;
    if (!whose.changeable) {
      answer = { refuses: { change_id: frame.change_id, message: READ_ONLY_WHY } };
    } else {
      try {
        await this.write(whose.clawAgent, frame);
        answer = { answers: frame.change_id };
        made = frame;
        const now = frame.model === null ? "OpenClaw's default" : `${frame.model}${frame.effort === null ? "" : ` at ${frame.effort}`}`;
        this.log(`openclaw: ${whose.clawAgent} runs on ${now}, from Chips`);
      } catch (error) {
        const message = String((error as Error)?.message ?? error).slice(0, MESSAGE_MAX);
        this.log(`openclaw: ${whose.clawAgent}'s model not changed from Chips: ${message}`);
        answer = { refuses: { change_id: frame.change_id, ...(message === "" ? {} : { message }) } };
      }
    }
    await this.agent(frame.agent_id, whose, answer, made);
  }

  /** An agent deleted: nothing more is sent for it. */
  forget(agentId: string): void {
    this.sent.delete(agentId);
  }

  /** Every read and send asked for so far, done; for the tests and for a clean stop. */
  async settled(): Promise<void> {
    await Promise.all(this.chains.values());
  }

  /** The agent's entry patched from the config as it is now, read again if it moved meanwhile. */
  private async write(clawAgent: string, frame: ChangeFrame): Promise<void> {
    const raw = patchOf(clawAgent, frame);
    for (let attempt = 1; ; attempt += 1) {
      const { hash } = await this.claw.request<{ hash?: string }>("config.get", {});
      try {
        await this.claw.request("config.patch", { raw, ...(hash === undefined ? {} : { baseHash: hash }) });
        return;
      } catch (error) {
        if (attempt >= WRITE_TRIES || !MOVED.test(String((error as Error)?.message ?? error))) throw error;
      }
    }
  }

  private queue(id: string, work: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      this.log(`chips: ${id}'s model not sent: ${String(error)}`);
    });
    this.chains.set(id, next);
    return next;
  }
}
