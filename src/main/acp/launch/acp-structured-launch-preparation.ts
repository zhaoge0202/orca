// Prepares a launch's account before its spawn.

import '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { launchPreparationFailure } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type { StructuredAgentSessionAcquireInput } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { AntigravityChatAuthConfig } from '../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import type { AcpStructuredSessionAdapterDeps } from '../session/acp-structured-session-adapter-deps'
import type { AcpLaunchSpec } from './acp-launch-contract'

export function prepareAcpStructuredLaunch(
  deps: Pick<AcpStructuredSessionAdapterDeps, 'resolveLaunch'>,
  acquire: Pick<StructuredAgentSessionAcquireInput, 'identity' | 'spawnToken' | 'permissionMode'>,
  closedBeforeSpawn: () => void
): Promise<AcpStructuredLaunch> {
  const resolveLaunch = () =>
    deps.resolveLaunch({
      identity: acquire.identity,
      spawnToken: acquire.spawnToken,
      ...(acquire.permissionMode ? { permissionMode: acquire.permissionMode } : {})
    })
  return prepareAcpLaunch(resolveLaunch, closedBeforeSpawn)
}

/** Prepares the backend the launch resolved to, which the chat's account home pins. */
export async function prepareAcpLaunch<
  Launch extends {
    command: string
    env: Record<string, string>
    spec: AcpLaunchSpec
    antigravityChatAuth?: AntigravityChatAuthConfig
  }
>(resolve: () => Promise<Launch>, closedBeforeSpawn: () => void): Promise<Launch> {
  const preparationFailure = (error: unknown): never => {
    closedBeforeSpawn()
    throw launchPreparationFailure(error)
  }
  const launch = await resolve().catch(preparationFailure)
  closedBeforeSpawn()
  const { prepare } = launch.spec.account
  if (prepare) {
    await prepare(launch.env, launch.antigravityChatAuth, closedBeforeSpawn).catch(
      preparationFailure
    )
    closedBeforeSpawn()
  }
  return launch
}
