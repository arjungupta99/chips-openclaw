/**
 * The room's project for our agents (Chips ADR 0221). Each agent the bridge made keeps its copy in
 * its own folder, `chips/<agent>/room` under OpenClaw's state, and the git is done here, on this
 * Mac, by Chips's SDK. The state is mounted from this Mac into the gateway's container (`media.ts`),
 * so the agent works on the same files at the container's path, and that is the path its turn is
 * told. The primary agent and OpenClaw's own agents work in a folder every room of theirs shares,
 * so they have none.
 */

import { Project } from "@chipschat/harness";
import { type ProjectFacts, renderProjectNote } from "@chipschat/protocol";
import { gatewayPathOf, type MediaRoots, macPathOf } from "./media.ts";

export interface Projects {
  /** One agent's copy of a room's project, in its folder (`folder`, as the gateway sees it). */
  of(input: { spaceId: string; agentId: string; name: string; folder: string }): Project;
  /** What a turn is told of the project, its copy named as the gateway sees it. */
  note(facts: ProjectFacts, othersInRoom: boolean): string;
}

/** The projects of the agents in OpenClaw's state, on Chips at `url` with the harness's token. */
export function projectsIn(
  roots: MediaRoots,
  chips: { readonly url: string; readonly token: string },
  log: (line: string) => void,
): Projects {
  return {
    of: (input) => new Project({ ...input, folder: macPathOf(roots, input.folder), url: chips.url, token: chips.token, log }),
    note: (facts, othersInRoom) => renderProjectNote({ ...facts, folder: gatewayPathOf(roots, facts.folder) }, { othersInRoom }),
  };
}
