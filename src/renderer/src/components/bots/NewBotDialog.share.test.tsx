// @vitest-environment happy-dom
// New bot opened from a reviewed link: the regular dialog, making the reviewed bot.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../shared/bot-types'
import type { BotShareReview } from '../../../../shared/bots/bot-share-received'

const mocks = vi.hoisted(() => ({
  createBot: vi.fn(),
  uploadBotAvatar: vi.fn(),
  openBotHomeTab: vi.fn(async () => true)
}))
vi.mock('@/lib/bot-catalog', () => ({
  createBot: mocks.createBot,
  uploadBotAvatar: mocks.uploadBotAvatar,
  openBotHomeTab: mocks.openBotHomeTab,
  readBotAvatarPng: vi.fn(async () => null),
  useHostBots: () => []
}))
vi.mock('./use-bot-agent-choices', () => ({
  useBotAgentMenu: () => ({ model: { state: 'loading' }, choices: ['claude'] })
}))
vi.mock('./BotAgentLaunchPicker', () => ({
  BotAgentLaunchPicker: ({ value }: { value: { agent: string; permissionMode?: string } }) => (
    <span>{`Agent ${value.agent} ${value.permissionMode ?? 'same as chats'}`}</span>
  )
}))

import { NewBotDialog } from './NewBotDialog'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const review: BotShareReview = {
  reviewId: 'review-1',
  shareId: 'share-1',
  versionId: 'version-1',
  publisher: 'Dara',
  publishedAt: '2026-11-08T00:00:00.000Z',
  bot: {
    schemaVersion: 1,
    name: 'Release notes',
    purpose: 'Drafts release notes.',
    agentHint: 'claude',
    skills: [],
    tools: [],
    connectors: [],
    schedules: [],
    eventSuggestions: [],
    memory: []
  },
  files: [],
  flags: [],
  leftOut: [],
  avatarDataUrl: 'data:image/png;base64,UE5H'
}

const created: Bot = {
  id: 'bot-1',
  name: 'Release notes',
  hostId: 'local',
  folder: 'release-notes',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

function renderFromShare() {
  const source = { review, toolIds: ['tool-1'], onBack: vi.fn(), onMoved: vi.fn() }
  const onOpenChange = vi.fn()
  render(
    <TooltipProvider>
      <NewBotDialog
        open
        onOpenChange={onOpenChange}
        initialName="Release notes"
        fromShare={source}
      />
    </TooltipProvider>
  )
  return { source, onOpenChange }
}

describe('NewBotDialog from a link', () => {
  it('is the regular dialog with one link line, no purpose, and Ask picked first', () => {
    renderFromShare()
    expect(screen.getByText("From Dara's link")).toBeTruthy()
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Release notes')
    expect(screen.getByText('Agent claude ask')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Template' })).toBeNull()
    expect(screen.queryByText(/Asks before running commands/)).toBeNull()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('makes the reviewed bot with the shared picture written by Create', async () => {
    mocks.createBot.mockResolvedValue(created)
    const { onOpenChange } = renderFromShare()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false, created))
    const [hostId, params] = mocks.createBot.mock.calls[0] ?? []
    expect(hostId).toBe('local')
    expect(params).toMatchObject({
      name: 'Release notes',
      agent: 'claude',
      permissionMode: 'ask',
      fromShare: { reviewId: 'review-1', toolIds: ['tool-1'] }
    })
    expect(params).not.toHaveProperty('avatar')
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()
  })

  it('goes back to the review when the link moved, and on Back', async () => {
    mocks.createBot.mockRejectedValue(new Error('bot_share_updated'))
    const { source, onOpenChange } = renderFromShare()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(source.onMoved).toHaveBeenCalledWith('updated'))
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(source.onBack).toHaveBeenCalled()
  })
})
