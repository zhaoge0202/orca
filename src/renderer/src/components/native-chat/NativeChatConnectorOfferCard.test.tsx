// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'

type Mocks = {
  bots: Bot[]
  start: ReturnType<typeof vi.fn>
  updateBot: ReturnType<typeof vi.fn>
  /** This computer's link to Orca Cloud as its bots.list says it. */
  localConnector: string | undefined
}
const mocks = vi.hoisted((): Mocks => ({
  bots: [],
  start: vi.fn(),
  updateBot: vi.fn(),
  localConnector: 'ok'
}))
vi.mock('@/lib/bot-catalog', () => ({
  useBots: () => mocks.bots,
  updateBot: mocks.updateBot,
  useBotHostConnectorStatus: () => mocks.localConnector,
  refreshBotHost: async () => undefined,
  useCardBot: (id: string) => ({
    bot: mocks.bots.find((bot: { id: string }) => bot.id === id) ?? null,
    ref: { hostId: 'local', id }
  })
}))
vi.mock('@/lib/bot-slack-state', () => ({
  useBotSlack: () => ({ status: 'loading' }),
  slackTeamState: () => ({ state: 'not_created' })
}))
vi.mock('@/lib/bot-github-state', () => ({ useBotGitHub: () => ({ status: 'loading' }) }))
vi.mock('../bots/ConnectorSetupDialogs', () => ({
  useConnectorSetup: () => ({ start: mocks.start, dialogs: null })
}))
// A paired server's own sign-in as the card reads it; its notice stands in as one line.
type ServerRead = {
  linkRead: boolean
  offline: boolean
  reading: boolean
  verified: boolean
  settled: boolean
  state: null | { kind: string }
  account: null | { state: string }
  connector: string | undefined
}
const server = vi.hoisted((): ServerRead => ({
  linkRead: true,
  offline: false,
  reading: false,
  verified: true,
  settled: true,
  state: null,
  account: null,
  connector: 'ok'
}))
vi.mock('../bots/use-bot-host-label', () => ({
  useBotHostLabel: (hostId: string) => (hostId === 'local' ? null : 'box1')
}))
vi.mock('@/lib/bot-host-status', () => ({ useBotHostVerified: () => server.verified }))
vi.mock('@/lib/bot-host-views', () => ({ useBotHostOffline: () => server.offline }))
vi.mock('@/lib/bot-host-link-read', () => ({ useBotHostLinkReadSinceOpen: () => server.linkRead }))
vi.mock('@/lib/bot-catalog-snapshot', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  readBotHostConnectorStatus: () => mocks.localConnector
}))
vi.mock('@/lib/bot-host-orca-account', () => ({
  useBotHostOrcaAccountSettled: () => server.settled,
  useBotHostOrcaAccountReading: () => server.reading
}))
vi.mock('../bots/BotConnectorsHostNotice', () => ({
  useServerNoticeState: () => ({
    state: server.state,
    account: server.account,
    connector: server.connector
  }),
  BotConnectorsHostNotice: () => <p>box1 notice: Sign in on box1</p>
}))

import { useAppStore } from '@/store'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { chatTakingSends, ORCA_SIGNED_OUT, orcaSignIn } from '../bots/orca-sign-in.test-fixture'
import { NativeChatBotKickoffContext } from './native-chat-bot-kickoff-view'
import { NativeChatConnectorOfferCard } from './NativeChatConnectorOfferCard'

const acme = { workspaceId: 'w1', workspaceName: 'Acme' }

function makeTestBot(overrides: Partial<Bot>): Bot {
  return {
    id: 'b1',
    name: 'Scout',
    hostId: 'local',
    folder: 'scout',
    folderWorkspaceId: 'scout-home',
    agent: 'claude',
    avatar: null,
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function show(bot: Bot, offer: { source: 'slack' | 'linear' | 'github'; workspace?: string }) {
  mocks.bots = [bot]
  render(
    <NativeChatConnectorOfferCard
      offer={{ botId: bot.id, ...offer }}
      messageId="m1"
      fallback="fallback line"
    />
  )
}

afterEach(() => {
  cleanup()
  mocks.start.mockClear()
})

describe('the Connect card', () => {
  it('connects through the same setup as Add connector', () => {
    show(makeTestBot({ id: 'b1' }), { source: 'linear' })
    fireEvent.click(screen.getByRole('button', { name: 'Connect Linear' }))
    expect(mocks.start).toHaveBeenCalledWith('linear')
  })

  it('reads Connected however it got connected, and adds another workspace from there', () => {
    show(makeTestBot({ id: 'b1', linear: acme, linearWorkspaces: [acme] }), { source: 'linear' })
    expect(screen.getByText('Connected in Acme')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add another workspace' }))
    expect(mocks.start).toHaveBeenCalledWith('linear')
  })

  it('still adds repositories or organizations once GitHub is connected', () => {
    show(makeTestBot({ id: 'b1', github: {} }), { source: 'github' })
    fireEvent.click(screen.getByRole('button', { name: 'Add repositories or organizations' }))
    expect(mocks.start).toHaveBeenCalledWith('github')
  })

  it('adds a named workspace the bot is not in', () => {
    show(makeTestBot({ id: 'b1', linear: acme, linearWorkspaces: [acme] }), {
      source: 'linear',
      workspace: 'Globex'
    })
    expect(screen.getByRole('button', { name: 'Add workspace' })).toBeTruthy()
  })

  it('shows the host line for a bot this window does not list', () => {
    mocks.bots = []
    render(
      <NativeChatConnectorOfferCard
        offer={{ botId: 'gone', source: 'slack' }}
        messageId="m1"
        fallback="fallback line"
      />
    )
    expect(screen.getByText('fallback line')).toBeTruthy()
  })
})

const chat = { send: vi.fn(async () => true) }
const chatView = chatTakingSends(chat.send)

describe('the Sign in card for a host signed out of Orca', () => {
  it('signs in from the chat and tells the bot, which then saves what it held', async () => {
    const initial = useAppStore.getState()
    useAppStore.setState({
      orcaProfileAuthStatus: ORCA_SIGNED_OUT,
      connectCurrentOrcaProfile: orcaSignIn()
    })
    chat.send.mockClear()
    mocks.updateBot.mockResolvedValue(undefined)
    mocks.bots = [makeTestBot({ slack: { appId: 'A1', teamId: 'T1' } })]
    try {
      render(
        <NativeChatBotKickoffContext.Provider value={chatView}>
          <NativeChatConnectorOfferCard
            offer={{ botId: 'b1', source: 'slack', signIn: true }}
            messageId="m1"
            fallback="fallback line"
          />
        </NativeChatBotKickoffContext.Provider>
      )
      expect(
        screen.getByText(
          'Slack events need Orca Cloud sign-in. I’ll save this rule once you’re in.'
        )
      ).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      await waitFor(() =>
        expect(chat.send).toHaveBeenCalledWith('I’m signed in to Orca Cloud now.')
      )
    } finally {
      useAppStore.setState(initial, true)
    }
  })

  describe("a paired server's bot: the server's own sign-in, never this computer's", () => {
    const serverBot = () =>
      stampBotHost('runtime:server', makeTestBot({ slack: { appId: 'A1', teamId: 'T1' } }))
    const showServer = (offer: { source: 'slack' | 'webhook' } = { source: 'slack' }) => {
      mocks.bots = [serverBot()]
      render(
        <NativeChatBotKickoffContext.Provider value={chatView}>
          <NativeChatConnectorOfferCard
            offer={{ botId: 'b1', ...offer, signIn: true }}
            messageId="m1"
            fallback="the server's own line"
          />
        </NativeChatBotKickoffContext.Provider>
      )
    }
    afterEach(() => {
      Object.assign(server, {
        linkRead: true,
        offline: false,
        reading: false,
        verified: true,
        settled: true,
        state: null,
        account: null,
        connector: 'ok'
      })
    })

    it('asks for the server signed in, with its notice and Sign in on the server', () => {
      server.state = { kind: 'signed-out' }
      server.account = { state: 'signed-out' }
      showServer()
      expect(
        screen.getByText(
          'Slack events need box1 signed in to Orca Cloud. I’ll save this rule once it is.'
        )
      ).toBeTruthy()
      expect(screen.getByText('box1 notice: Sign in on box1')).toBeTruthy()
      expect(screen.queryByText('Signed in to Orca')).toBeNull()
    })

    it('says webhooks wait on the server', () => {
      server.state = { kind: 'signed-out' }
      showServer({ source: 'webhook' })
      expect(
        screen.getByText('Webhooks need box1 signed in to Orca Cloud. I’ll make it once it is.')
      ).toBeTruthy()
    })

    it('reads Signed in only once the verified server is signed in and Orca Cloud takes it', () => {
      server.account = { state: 'signed-in' }
      showServer()
      expect(screen.getByText('Signed in to Orca')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
    })

    it.each([
      ['unverified', { verified: false }],
      ['offline, showing its last read', { offline: true }],
      ['a fresh read is still under way', { reading: true }],
      ['its link to Orca Cloud has not been read since the card opened', { linkRead: false }],
      ['its link to Orca Cloud is unknown', { connector: undefined }],
      ['its link to Orca Cloud says signed out', { connector: 'signed-out' }],
      ['unread', { settled: false }],
      ['unknown account', { account: null }],
      ['refused by Orca Cloud', { connector: 'refused' }],
      ['a sign-in Orca Cloud refuses', { connector: 'needs-sign-in' }]
    ])('keeps the server line, never Signed in, when %s', (_case, change) => {
      Object.assign(server, { account: { state: 'signed-in' } }, change)
      showServer()
      expect(screen.getByText("the server's own line")).toBeTruthy()
      expect(screen.queryByText('Signed in to Orca')).toBeNull()
      expect(screen.queryByRole('button')).toBeNull()
    })
  })
})

describe('a connected card whose host is not signed in to Orca Cloud', () => {
  afterEach(() => {
    server.state = null
    server.connector = 'ok'
  })

  it.each(['refused', 'signed-out', 'needs-sign-in', 'unreachable'])(
    'reads Paused when the server link is %s with no notice of its own',
    (connector) => {
      server.connector = connector
      show(stampBotHost('runtime:server', makeTestBot({ github: {} })), { source: 'github' })
      expect(screen.getByText('Paused')).toBeTruthy()
      expect(screen.getByText('Slack, Linear and GitHub aren’t reaching Scout.')).toBeTruthy()
    }
  )

  it("reads Paused with the server's notice, never Connected", () => {
    server.state = { kind: 'signed-out' }
    show(stampBotHost('runtime:server', makeTestBot({ github: {} })), { source: 'github' })
    expect(screen.getByText('Paused')).toBeTruthy()
    expect(screen.queryByText('Connected')).toBeNull()
    expect(screen.getByText('box1 notice: Sign in on box1')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add repositories or organizations' })).toBeTruthy()
  })

  it("stays Connected when the server only needs an update, which doesn't stop its events", () => {
    server.state = { kind: 'update-needed' }
    show(stampBotHost('runtime:server', makeTestBot({ github: {} })), { source: 'github' })
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0)
    expect(screen.queryByText('Paused')).toBeNull()
  })

  it('reads Paused with Sign in for this computer while it is signed out', () => {
    const initial = useAppStore.getState()
    useAppStore.setState({ orcaProfileAuthStatus: ORCA_SIGNED_OUT })
    try {
      show(makeTestBot({ github: {} }), { source: 'github' })
      expect(screen.getByText('Paused')).toBeTruthy()
      expect(
        screen.getByText('GitHub connects through Orca Cloud. Sign in to Orca to continue.')
      ).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    } finally {
      useAppStore.setState(initial, true)
    }
  })
})

describe("this computer's sign-in that Orca Cloud refuses", () => {
  afterEach(() => {
    mocks.localConnector = 'ok'
  })

  it('asks to sign in again, never Signed in, though this computer has a sign-in', () => {
    mocks.localConnector = 'needs-sign-in'
    mocks.bots = [makeTestBot({ slack: { appId: 'A1', teamId: 'T1' } })]
    render(
      <NativeChatBotKickoffContext.Provider value={chatView}>
        <NativeChatConnectorOfferCard
          offer={{ botId: 'b1', source: 'slack', signIn: true }}
          messageId="m1"
          fallback="fallback line"
        />
      </NativeChatBotKickoffContext.Provider>
    )
    expect(screen.queryByText('Signed in to Orca')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('reads Paused on a connected card', () => {
    mocks.localConnector = 'needs-sign-in'
    show(makeTestBot({ github: {} }), { source: 'github' })
    expect(screen.getByText('Paused')).toBeTruthy()
  })
})

describe('signing this computer in again from the chat', () => {
  afterEach(() => {
    mocks.localConnector = 'ok'
  })

  it("tells the bot only once Orca Cloud takes this computer's sign-in", async () => {
    const initial = useAppStore.getState()
    const connect = vi.fn(orcaSignIn())
    useAppStore.setState({
      orcaProfileAuthStatus: ORCA_SIGNED_OUT,
      connectCurrentOrcaProfile: connect
    })
    chat.send.mockClear()
    mocks.localConnector = 'needs-sign-in'
    mocks.bots = [makeTestBot({ slack: { appId: 'A1', teamId: 'T1' } })]
    try {
      render(
        <NativeChatBotKickoffContext.Provider value={chatView}>
          <NativeChatConnectorOfferCard
            offer={{ botId: 'b1', source: 'slack', signIn: true }}
            messageId="m1"
            fallback="fallback line"
          />
        </NativeChatBotKickoffContext.Provider>
      )
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
      // The sign-in and the re-read of this computer's link both settle before the check.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(chat.send).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    } finally {
      useAppStore.setState(initial, true)
    }
  })
})
