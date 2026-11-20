// The Connect card a bot asks for with `orca bot connectors --offer`: connects in one click, and reads
// Connected however the connector got added, with the action that adds access to it.
import { botTarget } from '@/lib/bot-hosts'
import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { refreshBotHost, useCardBot } from '@/lib/bot-catalog'
import { useBotGitHub } from '@/lib/bot-github-state'
import { slackTeamState, useBotSlack } from '@/lib/bot-slack-state'
import { connectorDescription } from '../bots/AddConnectorDialog'
import { BotAppBrandLogo } from '../bots/apps/BotAppBrandLogo'
import { BOT_CONNECTORS, connectorAddAccessLabel, connectorAdded } from '../bots/bot-connectors'
import { useConnectorSetup } from '../bots/ConnectorSetupDialogs'
import { useGoogleHost } from '../bots/google/google-connect-client'
import { botLinearWorkspaces, botSlackApps, type Bot } from '../../../../shared/bot-types'
import {
  CONNECTOR_OFFER_NAMES,
  type ConnectorOffer,
  type ConnectorOfferSource,
  type LinkedOfferSource
} from '../../../../shared/bots/bot-connector-offer'
import { googleBotConnectState } from '../../../../shared/google/google-bot-connect-state'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import {
  NativeChatCardActions,
  NativeChatCardFrame,
  NativeChatCardStatus
} from './NativeChatCardFrame'
import { NativeChatOfferActions, useNativeChatOffer } from './NativeChatOfferActions'
import { OrcaCloudSignInLine, orcaCloudSignInReason } from '../bots/orca-cloud-sign-in'
import { useOrcaCloudNeedsSignIn } from '../bots/orca-cloud-signed-out'
import { BotConnectorsHostNotice, useServerNoticeState } from '../bots/BotConnectorsHostNotice'
import { useBotHostLabel } from '../bots/use-bot-host-label'
import { useBotHostVerified } from '@/lib/bot-host-status'
import {
  useBotHostOrcaAccountReading,
  useBotHostOrcaAccountSettled
} from '@/lib/bot-host-orca-account'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { useBotHostLinkReadSinceOpen } from '@/lib/bot-host-link-read'
import { readBotHostConnectorStatus } from '@/lib/bot-catalog-snapshot'

type OfferProps = {
  bot: Bot
  offer: ConnectorOffer & { source: ConnectorOfferSource }
  messageId: string
  /** Why a connected source's events still don't reach the bot (its host's sign-in), and its fix. */
  pause?: React.ReactNode
}

/** The bot's workspaces or orgs for the source, by name, as far as they are known yet. */
function SlackOffer(props: OfferProps): React.JSX.Element {
  const view = useBotSlack(props.bot)
  const names = botSlackApps(props.bot).flatMap((app) => {
    const team = view.status === 'ready' ? slackTeamState(view.slack, app.teamId) : null
    return team?.state === 'installed' && team.teamName ? [team.teamName] : []
  })
  return <OfferCard {...props} names={names} />
}

// Connected only once the bot may use Google and this computer is signed in to it.
function GoogleOffer(props: OfferProps): React.JSX.Element {
  const view = useGoogleHost(botTarget(props.bot))
  const state =
    view.status === 'ready'
      ? googleBotConnectState({
          allowed: props.bot.google === true,
          client: view.google.client,
          accounts: view.google.accounts
        })
      : null
  const connected = state?.allowed === true && state.host === 'connected'
  return <OfferCard {...props} names={[]} connected={connected} />
}

function GitHubOffer(props: OfferProps): React.JSX.Element {
  const view = useBotGitHub(props.bot.hostId)
  const removed = props.bot.github?.removedInstallationIds ?? []
  const names =
    props.bot.github && view.status === 'ready'
      ? view.github.installations
          .filter((entry) => !removed.includes(entry.installationId))
          .map((entry) => entry.accountLogin)
      : []
  return <OfferCard {...props} names={names} />
}

// How the bot can work there without the connector: as its owner.
function offerFootnote(source: ConnectorOfferSource): string | null {
  switch (source) {
    case 'github':
      return translate(
        'components.native-chat.connectorOffer.githubAsYou',
        'It can also work in GitHub as you, through your gh login.'
      )
    case 'linear':
      return translate(
        'components.native-chat.connectorOffer.linearAsYou',
        'It can also work in Linear as you, through your own Linear sign-in in Orca.'
      )
    case 'slack':
    case 'google':
      return null
  }
}

function OfferCard({
  bot,
  offer,
  messageId,
  names,
  pause,
  connected: connectedOverride
}: OfferProps & { names: readonly string[]; connected?: boolean }): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  const answering = useNativeChatOffer(bot.id, messageId)
  const setup = useConnectorSetup(bot)
  const connector = BOT_CONNECTORS.find((entry) => entry.id === offer.source)
  const wanted = offer.workspace?.toLowerCase()
  const connected =
    connectedOverride ??
    (wanted
      ? names.some((name) => name.toLowerCase() === wanted)
      : connectorAdded(bot, offer.source))
  const label = connector?.label ?? offer.source
  // Connected, but its host's sign-in keeps the events away: never reads as done.
  const paused = connected && pause != null
  const footnote = offerFootnote(offer.source)
  const addsWorkspace = offer.workspace !== undefined && connectorAdded(bot, offer.source)
  const actionLabel = addsWorkspace
    ? offer.source === 'github'
      ? t('components.native-chat.connectorOffer.addOrg', 'Add org')
      : t('components.native-chat.connectorOffer.addWorkspace', 'Add workspace')
    : t('components.native-chat.connectorOffer.connectService', 'Connect {{service}}', {
        service: label
      })
  const footer = connected ? (
    // Connected still adds access: GitHub repositories or organizations, or another workspace.
    offer.source === 'google' ? undefined : (
      <NativeChatCardActions>
        <Button type="button" variant="outline" size="sm" onClick={() => setup.start(offer.source)}>
          {connectorAddAccessLabel(offer.source)}
        </Button>
      </NativeChatCardActions>
    )
  ) : (
    <NativeChatOfferActions offer={answering}>
      <Button type="button" size="sm" onClick={() => setup.start(offer.source)}>
        {actionLabel}
      </Button>
    </NativeChatOfferActions>
  )
  return (
    <NativeChatCardFrame
      avatar={
        <span className="mt-0.5">
          <BotAppBrandLogo app={connector ?? { id: offer.source }} />
        </span>
      }
      heading={t('components.native-chat.connectorOffer.heading', 'Connect a service')}
      status={
        paused ? (
          <NativeChatCardStatus tone="warning">
            {t('components.native-chat.connectorOffer.paused', 'Paused')}
          </NativeChatCardStatus>
        ) : connected ? (
          <NativeChatCardStatus tone="success">
            {t('components.native-chat.connectorOffer.connected', 'Connected')}
          </NativeChatCardStatus>
        ) : null
      }
      title={offer.workspace ? `${label} · ${offer.workspace}` : label}
      footer={footer}
    >
      {paused ? (
        <div className="mt-0.5">{pause}</div>
      ) : connected ? (
        names.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('components.native-chat.connectorOffer.connectedIn', 'Connected in {{places}}', {
              places: names.join(', ')
            })}
          </p>
        ) : null
      ) : (
        <>
          <p className="mt-0.5">{connectorDescription(offer.source)}</p>
          {footnote ? <p className="mt-0.5 text-xs text-muted-foreground">{footnote}</p> : null}
        </>
      )}
      {setup.dialogs}
    </NativeChatCardFrame>
  )
}

type SignInOfferProps = { bot: Bot; offer: ConnectorOffer; messageId: string }

// Why the bot asks: what waits on this computer's sign-in.
function signInReason(offer: ConnectorOffer): string {
  return offer.source === 'webhook'
    ? translate(
        'bots.cloudSignIn.webhooksChat',
        'Webhooks need Orca Cloud sign-in. I’ll make it once you’re in.'
      )
    : translate(
        'bots.cloudSignIn.eventsChat',
        '{{source}} events need Orca Cloud sign-in. I’ll save this rule once you’re in.',
        { source: CONNECTOR_OFFER_NAMES[offer.source] }
      )
}

/** The bot's host is signed in: Continue tells the bot, which then saves what it held. */
function SignedInRow({
  answering
}: {
  answering: ReturnType<typeof useNativeChatOffer>
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <p className="flex min-w-0 flex-1 items-center gap-1">
        <Check className="size-3" aria-hidden />
        {t('bots.cloudSignIn.signedIn', 'Signed in to Orca')}
      </p>
      {answering.sent ? null : (
        <Button type="button" variant="outline" size="xs" onClick={() => tellBot(answering)}>
          {t('bots.cloudSignIn.continue', 'Continue')}
        </Button>
      )}
    </div>
  )
}

function tellBot(answering: ReturnType<typeof useNativeChatOffer>): void {
  answering.send(translate('bots.cloudSignIn.toldBot', 'I’m signed in to Orca Cloud now.'), [])
}

/** Signed out of Orca: one line with Sign in, which tells the bot once signed in so it saves what it held. */
function SignInOffer({ bot, offer, messageId }: SignInOfferProps): React.JSX.Element {
  useTranslation()
  const answering = useNativeChatOffer(bot.id, messageId)
  // Signed in only while Orca Cloud takes this computer's sign-in, not merely while it has one.
  const needsSignIn = useOrcaCloudNeedsSignIn()
  if (!needsSignIn) {
    return <SignedInRow answering={answering} />
  }
  // Signing in again clears a refused sign-in only once this computer's link reads ok: tell the bot then.
  const tellOnceLinked = async (): Promise<void> => {
    await refreshBotHost(LOCAL_EXECUTION_HOST_ID)
    if (readBotHostConnectorStatus(LOCAL_EXECUTION_HOST_ID) === 'ok') {
      tellBot(answering)
    }
  }
  return <OrcaCloudSignInLine text={signInReason(offer)} onSignedIn={tellOnceLinked} />
}

// Why the bot asks, for a server: its own sign-in, which the owner starts from here.
function serverSignInReason(offer: ConnectorOffer, host: string): string {
  return offer.source === 'webhook'
    ? translate(
        'bots.cloudSignIn.webhooksHostChat',
        'Webhooks need {{host}} signed in to Orca Cloud. I’ll make it once it is.',
        { host }
      )
    : translate(
        'bots.cloudSignIn.eventsHostChat',
        '{{source}} events need {{host}} signed in to Orca Cloud. I’ll save this rule once it is.',
        { source: CONNECTOR_OFFER_NAMES[offer.source], host }
      )
}

/**
 * A server bot's Sign in card: the server's own sign-in, never this desktop's. Signed in only once the
 * verified server says so and its link to Orca Cloud takes it; a server whose state isn't known yet
 * keeps its own line.
 */
function ServerSignInOffer({
  bot,
  offer,
  messageId,
  fallback
}: SignInOfferProps & { fallback: string }): React.JSX.Element {
  useTranslation()
  const host = useBotHostLabel(bot.hostId)
  const verified = useBotHostVerified(bot.hostId)
  const settled = useBotHostOrcaAccountSettled(bot.hostId)
  const { state, account, connector } = useServerNoticeState(bot.hostId, bot)
  const answering = useNativeChatOffer(bot.id, messageId)
  const offline = useBotHostOffline(bot.hostId)
  const reading = useBotHostOrcaAccountReading(bot.hostId)
  const linkRead = useBotHostLinkReadSinceOpen(bot.hostId, refreshBotHost)
  // Only positive proof, read now: a live, verified server signed in, and its link to Orca Cloud read
  // since this card opened and saying ok. Having told the bot once proves nothing about it since.
  const ready =
    verified &&
    settled &&
    !reading &&
    linkRead &&
    !offline &&
    state === null &&
    account?.state === 'signed-in' &&
    connector === 'ok'
  if (host && ready) {
    return <SignedInRow answering={answering} />
  }
  if (host && state) {
    return (
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>{serverSignInReason(offer, host)}</p>
        <BotConnectorsHostNotice bot={bot} />
      </div>
    )
  }
  return <p className="text-sm text-chat-foreground-faint">{fallback}</p>
}

/**
 * A server bot's connected source whose events don't reach it: the server's notice, or, when its link
 * to Orca Cloud is down with no notice of its own (refused, or stopped while signed in), why.
 */
function ServerOffer(props: OfferProps): React.JSX.Element {
  useTranslation()
  const host = useBotHostLabel(props.bot.hostId)
  const { state, connector } = useServerNoticeState(props.bot.hostId, props.bot)
  // An older server's update notice doesn't mean its events stopped.
  const noticed = state !== null && state.kind !== 'update-needed'
  const linkDown = connector !== undefined && connector !== 'ok'
  const pause =
    host === null ? undefined : noticed ? (
      <BotConnectorsHostNotice bot={props.bot} />
    ) : linkDown ? (
      <p className="text-xs text-muted-foreground">
        {translate(
          'bots.host.notice.notReaching',
          'Slack, Linear and GitHub aren’t reaching {{name}}.',
          {
            name: props.bot.name
          }
        )}
      </p>
    ) : undefined
  return <SourceOffer {...props} pause={pause} />
}

/** This computer's bot while it isn't signed in to Orca Cloud: its events wait on this sign-in. */
function LocalOffer(
  props: OfferProps & { offer: { source: LinkedOfferSource } }
): React.JSX.Element {
  const needsSignIn = useOrcaCloudNeedsSignIn()
  return (
    <SourceOffer
      {...props}
      pause={
        needsSignIn ? (
          <OrcaCloudSignInLine text={orcaCloudSignInReason(props.offer.source)} />
        ) : undefined
      }
    />
  )
}

function SourceOffer(props: OfferProps): React.JSX.Element {
  switch (props.offer.source) {
    case 'slack':
      return <SlackOffer {...props} />
    case 'github':
      return <GitHubOffer {...props} />
    case 'google':
      return <GoogleOffer {...props} />
    case 'linear':
      return (
        <OfferCard
          {...props}
          names={botLinearWorkspaces(props.bot).map((entry) => entry.workspaceName)}
        />
      )
  }
}

export function NativeChatConnectorOfferCard({
  offer,
  messageId,
  fallback
}: {
  offer: ConnectorOffer
  messageId: string
  /** The host's line, for a bot this window doesn't list. */
  fallback: string
}): React.JSX.Element {
  // The bot on the host this chat runs on: ids are random per host, so another host's may match.
  const { bot } = useCardBot(offer.botId)
  if (!bot) {
    return <p className="text-sm text-chat-foreground-faint">{fallback}</p>
  }
  if (offer.signIn || offer.source === 'webhook') {
    // Sign in here signs in only this desktop; another host's bot keeps the host's own line.
    return bot.hostId === LOCAL_EXECUTION_HOST_ID ? (
      <SignInOffer bot={bot} offer={offer} messageId={messageId} />
    ) : (
      <ServerSignInOffer bot={bot} offer={offer} messageId={messageId} fallback={fallback} />
    )
  }
  const source = offer.source
  // Google's events come from the host's own Google sign-in, not through Orca Cloud.
  if (source === 'google') {
    return <GoogleOffer bot={bot} offer={{ ...offer, source }} messageId={messageId} />
  }
  const props = { bot, offer: { ...offer, source }, messageId }
  return bot.hostId === LOCAL_EXECUTION_HOST_ID ? (
    <LocalOffer {...props} />
  ) : (
    <ServerOffer {...props} />
  )
}
