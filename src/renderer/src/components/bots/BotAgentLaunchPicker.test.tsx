// @vitest-environment happy-dom
import { rpc } from '../agent/launch-menu/new-tab-agent-menu-host-preferences-test-fixture'
import { act, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'

const picker: { entries: AgentPickerEntry[]; open?: (open: boolean) => void } = vi.hoisted(() => ({
  entries: []
}))
// Stands in for the user opening the agent picker.
vi.mock('@/components/agent/AgentLaunchPicker', () => ({
  AgentLaunchPicker: (props: {
    entries: AgentPickerEntry[]
    onOpenChange: (o: boolean) => void
  }) => {
    picker.entries = props.entries
    picker.open = props.onOpenChange
    return null
  }
}))

import { BotAgentLaunchPicker } from './BotAgentLaunchPicker'
import { useBotAgentMenu } from './use-bot-agent-choices'

// As New bot wires it: the Computer picked drives the agent menu the picker reads models through.
function NewBotAgent({ hostId }: { hostId: ExecutionHostId }) {
  const { model, choices } = useBotAgentMenu(hostId, true)
  return (
    <BotAgentLaunchPicker
      key={hostId}
      model={model}
      choices={choices}
      value={{ agent: 'codex' }}
      onChange={() => {}}
    />
  )
}

const codexModels = () => {
  const catalog = picker.entries.find((entry) => entry.agent === 'codex')?.catalog
  return catalog && catalog.origin !== 'unknown' ? catalog.models.map((model) => model.id) : []
}

it("lists the picked computer's Codex models, and the new computer's after switching", async () => {
  const settings = rpc.call.getMockImplementation()!
  const hostModels: Record<string, string> = { alpha: 'gpt-6.2-sol', beta: 'gpt-6.2-astra' }
  rpc.call.mockImplementation(
    (target: { kind: string; environmentId?: string }, method: string, params: unknown) =>
      method !== 'agentSession.modelCatalog'
        ? settings(target, method, params)
        : target.kind !== 'environment'
          ? { origin: 'unknown' }
          : {
              origin: 'probe',
              fetchedAt: 1,
              models: [
                {
                  id: hostModels[target.environmentId ?? ''],
                  label: target.environmentId,
                  isDefault: true,
                  efforts: []
                }
              ]
            }
  )
  const view = render(<NewBotAgent hostId="runtime:alpha" />)
  act(() => picker.open?.(true))
  await waitFor(() => expect(codexModels()).toEqual(['gpt-6.2-sol']))

  view.rerender(<NewBotAgent hostId="runtime:beta" />)
  act(() => picker.open?.(true))
  await waitFor(() => expect(codexModels()).toEqual(['gpt-6.2-astra']))
})
