import { useState } from 'react'
import type { BotAgent } from '../../../../shared/bot-types'
import type { BotAgentSetup } from './BotAgentLaunchPicker'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { agentChatPermissionModes } from '../../../../shared/agent-launch/permissions/agent-chat-permission-support'
import type { AgentChatPermissionMode } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'

/** `mode` on `agent`, where that agent offers it. */
function withPermission(agent: BotAgent, mode: AgentChatPermissionMode | undefined): BotAgentSetup {
  const offered = agentChatPermissionModes(agent)?.modes.find((each) => each === mode)
  return offered ? { agent, permissionMode: offered } : { agent }
}

/** A new bot's agent, model and permissions on `hostId`. Follows the first agent that computer has,
 *  on its defaults, until the owner picks one it has; a pick made for another computer starts over,
 *  since its model and options may not be offered there. `initialPermission` is picked first, on
 *  whichever agent it is followed onto that offers it. */
export function useBotAgentSetup(
  choices: readonly BotAgent[],
  hostId: ExecutionHostId,
  initialAgent?: BotAgent,
  initialPermission?: AgentChatPermissionMode
) {
  const first = withPermission(initialAgent ?? 'claude', initialPermission)
  const [picked, setPicked] = useState<{ hostId: ExecutionHostId | null; setup: BotAgentSetup }>({
    hostId: null,
    setup: first
  })
  const own = picked.hostId === null || picked.hostId === hostId ? picked.setup : first
  const setup = choices.includes(own.agent)
    ? own
    : withPermission(choices[0] ?? own.agent, own.permissionMode)
  return {
    setup,
    setSetup: (next: BotAgentSetup) => setPicked({ hostId, setup: next }),
    reset: () => setPicked({ hostId: null, setup: first })
  }
}
