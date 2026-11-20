import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Dialog } from './ui'
import { FEEDBACK } from './BetaNotice'

/**
 * Veyra Study's own Privacy Policy and Terms of Service, shown inside the app
 * (Settings → Data & privacy, Help, and the sign-up screen).
 *
 * Keep them true to the code: when what the app stores, sends or keeps changes,
 * change these pages in the same commit and bump LEGAL_UPDATED. Not legal advice.
 *
 * The Veyra account itself (username, email, password, friends) is run by the
 * account service shared with IronLog and Cashline and has its own policy; these
 * pages point there instead of describing it.
 */
export const LEGAL_UPDATED = '20 November 2026'
/** The law the Terms are under, e.g. 'the laws of Singapore'. Empty: the clause is left out until the owner fills it in. */
const GOVERNING_LAW = ''
const OWNER = FEEDBACK.owner
const EMAIL = FEEDBACK.email

type Block = string | string[]
type Doc = { title: string; intro: string; sections: { h: string; body: Block[] }[] }

export const PRIVACY: Doc = {
  title: 'Privacy Policy',
  intro: `Veyra Study is a free study app made and run by one person, ${OWNER} (“we”, “us”). This policy explains what the app keeps on your device, what it sends elsewhere and why, who can see it, and how long it’s kept. We don’t sell your data, show ads, or use analytics or tracking.`,
  sections: [
    {
      h: 'On your device',
      body: [
        'Your subjects, tasks, notes, study sessions and settings are stored on your device: in a file for each Veyra account on a computer, on the phone in the Android app, and in your browser on the website. They stay there unless you turn on sync (below).',
        'You can export everything, import a backup, or open the data folder in Settings → Data & privacy. Uninstalling the app or clearing the site’s data deletes what’s on that device.',
        'On a computer, your sign-in is kept in the system’s secure storage. API keys you add for your own AI provider, and Google connections, stay on your device.'
      ]
    },
    {
      h: 'Your Veyra account',
      body: [
        'Veyra accounts are shared with IronLog and Cashline and are run by the Veyra account service, which holds your username, display name, profile photo, optional email address, password (stored as a hash) and friends list. That service’s own Terms and Privacy Policy, linked on the sign-up screen, cover it.',
        'Veyra Study receives your username, display name, profile photo and whether your email is verified, so that people can find you in Group work and Messages.'
      ]
    },
    {
      h: 'Group work and messages',
      body: [
        'Group work and Messages use the Veyra group server, which we run. It stores:',
        [
          'your profile card (username, display name, photo), when you joined and when you were last seen;',
          'your groups, their members, invites and invite codes;',
          'what you put in a group: tasks, deadlines, chat messages, shared notes and their history, and files;',
          'direct messages, which are stored as a group with two members;',
          'notes you share with someone, and announcements you’ve read.'
        ],
        'Members of a group can see what’s in it. These messages and items are not end-to-end encrypted: they are stored on the server so they can reach every member’s devices.',
        'To keep Group work safe, the owner has moderation tools that can list users and groups, show a group’s items and its latest 300 messages (direct messages included), remove items or members, and block accounts. We use them only to deal with reports, abuse or technical problems.',
        'Tasks, messages and deadlines you delete in a group are removed for good 30 days later. Shared notes, their history and files stay while they’re shared. The server keeps backups for up to about five weeks, so deleted data can remain in a backup until it rolls off.'
      ]
    },
    {
      h: 'Sync',
      body: [
        'Sync is optional. When it’s on, your personal records (subjects, tasks, notes, study time, settings, and note history unless you turn that off) are stored on the group server so your other devices can get them. They are stored readable, not end-to-end encrypted.',
        'When you delete something, the server keeps a record that it was deleted so your other devices delete it too. That record can still hold what was deleted, except old note history, which is cleared 60 days after it’s deleted. Email us to have your synced data removed entirely.',
        'Assistant chat history is different: it is encrypted on your device with a key made from your password before it’s sent, so neither the server nor we can read it.'
      ]
    },
    {
      h: 'Veyra AI and other AI features',
      body: [
        'Veyra AI sends what you ask, along with any notes, files or pages you include, through our server to Anthropic, which runs the Claude models that answer. Anthropic processes it under its own terms and privacy policy. Our server records how much you used (the model, the number of tokens, the cost and the time) to apply usage limits. It does not keep what you asked or the answers.',
        'If you add your own API key for Claude, Gemini or OpenAI, your requests go straight from your device to that company, under its own terms.',
        'Local AI and voice transcription run entirely on your device.'
      ]
    },
    {
      h: 'Connections you choose',
      body: [
        [
          'Google Calendar: reads your calendar list and events, and can add events to a calendar Veyra Study creates. Events are shown in the app and stay on your device.',
          'Google Drive: read-only. Lets the Assistant find and read files you ask about; what it reads goes to the AI provider you’re using, as above.',
          'Calendar links (iCal): the app downloads the calendar from the address you add.',
          'AI apps (MCP): a connection on your own computer that lets an AI app you’ve set up read your study data, and change it if you allow that. What you share with that app is covered by its own policy.'
        ],
        'You can disconnect any of these in Settings → Connections.'
      ]
    },
    {
      h: 'Voice calls',
      body: ['Voice calls in Group work go directly between the people in the call. When a direct connection isn’t possible, the audio passes through Cloudflare’s relay. Calls are not recorded. The server only keeps track of who is in a call while it’s happening.']
    },
    {
      h: 'Diagnostics',
      body: [
        'The computer app keeps a small technical log on your device (Settings → Data & privacy → Diagnostics). It records app events such as starting and quitting, windows opening and closing, crashes, sleep and display changes, update checks and error messages. It never records your notes, tasks, messages or account details, and your Windows user name, email addresses and sign-in tokens are removed from it before anything is written.',
        'The log leaves your device in three cases only:',
        [
          'you press Send in Settings → Data & privacy, after seeing the exact text and saying what happened;',
          'you turned on “Send reports automatically” (it’s off unless you do): then, after a crash, a window that stops responding or goes missing, or Veyra closing unexpectedly, the latest part of the log is sent without asking first, at most once every six hours, and Veyra asks you afterwards what happened;',
          'Veyra Study couldn’t open properly and you press “Send a report” in the message it shows.'
        ],
        'A report is linked to your username, along with your app version and Windows version, and anything you write about what happened. It is readable only by the owner, used only to find and fix problems, and deleted 90 days after it was sent.'
      ]
    },
    {
      h: 'Other services the app talks to',
      body: [
        [
          'GitHub, to check for and download updates. GitHub sees your IP address.',
          'Cloudflare, which hosts the website and carries the connection to the group server.',
          'Anthropic, Google and OpenAI, only for the features above that you use.',
          'Stripe, if you buy a plan: it handles the payment on its own pages, and we never see your card details. We keep which plan you have, its status and renewal date, and your Stripe customer number.'
        ],
        'The group server also keeps a technical log of what it does (times, usernames and errors) so problems can be fixed. Only the owner can read it.',
        'We don’t share your data with anyone else, except where the law requires it.'
      ]
    },
    {
      h: 'How long things are kept',
      body: [
        [
          'On your device: until you delete them.',
          'Group items and messages: while the group exists. Deleted tasks, messages and deadlines go after 30 days, and backups after about five weeks.',
          'Sync records: while you use sync; deleted ones as described above, or until you ask us to remove them.',
          'Sign-in sessions on the group server: 30 days.',
          'AI usage records: kept to apply limits and track costs.',
          'Diagnostic reports: 90 days.'
        ]
      ]
    },
    {
      h: 'Your choices',
      body: [
        'You can export your data, leave or delete groups, delete messages and items, turn sync off, and disconnect Google or AI apps at any time. To have everything about you removed from the group server, or for a copy of what it holds, email us. For your Veyra account itself, use the account service.'
      ]
    },
    {
      h: 'Age',
      body: ['You need to be 16 or over to create a Veyra account.']
    },
    {
      h: 'Security',
      body: ['Connections use HTTPS, passwords are never stored in plain text, and Assistant chat sync is end-to-end encrypted. No system is perfectly secure, so please don’t put anything in Veyra Study you couldn’t afford to have exposed.']
    },
    {
      h: 'Changes to this policy',
      body: ['When this policy changes, the new version comes with an app update, and the date at the top changes. Important changes are listed in What’s new.']
    },
    {
      h: 'Contact',
      body: [`Questions or requests: ${EMAIL}.`]
    }
  ]
}

export const TERMS: Doc = {
  title: 'Terms of Service',
  intro: `These terms are an agreement between you and ${OWNER} (“we”, “us”), who makes and runs Veyra Study. By using the app, the website or the group server, you agree to them. If you don’t agree, please don’t use Veyra Study.`,
  sections: [
    {
      h: 'Who can use it',
      body: ['You must be 16 or over to create a Veyra account. Your Veyra account is also covered by the Veyra account service’s own terms. Keep your password safe: you’re responsible for what happens under your account.']
    },
    {
      h: 'What Veyra Study is',
      body: ['A free study app run by one person, still being built. Features can change, be paused or end. The group server is switched off from about midnight to 8 am, so Group work, sync, Veyra AI and voice calls aren’t available then. We don’t promise that any part of it will always be available or free of bugs.']
    },
    {
      h: 'Your content',
      body: [
        'What you create stays yours. You give us permission to store, copy and send it only as needed to run the features you use, such as syncing it to your devices or delivering it to your group.',
        'What you post in a group can be seen and kept by its members.',
        'Keep your own backups (Settings → Data & privacy → Export). We aren’t responsible for lost data.'
      ]
    },
    {
      h: 'Acceptable use',
      body: [
        'Don’t use Veyra Study to:',
        [
          'harass, threaten, bully or impersonate anyone;',
          'share content that is illegal, sexual content involving minors, hateful, or infringes someone else’s rights;',
          'send spam or malware, or try to break into, overload, or get around the limits of the app, the server or other people’s accounts;',
          'misuse Veyra AI, for example by trying to get around its usage limits or using it for anything against Anthropic’s usage policies.'
        ],
        'We can remove content, remove people from groups, limit features or block accounts that break these rules, without notice where needed.'
      ]
    },
    {
      h: 'AI features',
      body: [
        'AI answers can be wrong, incomplete or out of date. Check anything important. They aren’t professional, medical, legal or financial advice.',
        'You’re responsible for following your school’s rules on using AI and on academic integrity.',
        'Access to Veyra AI is given by us, with usage limits, and can be changed or withdrawn at any time.'
      ]
    },
    {
      h: 'Other services',
      body: ['Some features rely on other companies, such as Google, Anthropic, OpenAI, Cloudflare and GitHub. Using them is also subject to their terms.']
    },
    {
      h: 'Ending',
      body: ['You can stop using Veyra Study at any time. We may suspend or end your access to Group work, sync or Veyra AI if you break these terms, or if we stop running them.']
    },
    {
      h: 'No warranty',
      body: ['Veyra Study is provided “as is” and “as available”, without warranties of any kind, as far as the law allows.']
    },
    {
      h: 'Limit of liability',
      body: ['As far as the law allows, we aren’t liable for indirect or consequential losses, or for lost data, missed deadlines or lost marks, arising from your use of Veyra Study. Nothing in these terms limits rights you have under consumer law that can’t be excluded.']
    },
    {
      h: 'Changes',
      body: ['We may update these terms. The new version comes with an app update and a new date at the top. If you keep using Veyra Study after that, you accept the new terms.']
    },
    ...(GOVERNING_LAW ? [{ h: 'Governing law', body: [`These terms are governed by ${GOVERNING_LAW}.`] as Block[] }] : []),
    {
      h: 'Contact',
      body: [`Questions: ${EMAIL}.`]
    }
  ]
}

export type LegalWhich = 'privacy' | 'terms'
const DOCS: Record<LegalWhich, Doc> = { privacy: PRIVACY, terms: TERMS }

/** One legal page as readable text. */
export function LegalText({ which }: { which: LegalWhich }): ReactNode {
  const doc = DOCS[which]
  return (
    <div className="legal">
      <p className="legal-date">Last updated {LEGAL_UPDATED}</p>
      <p>{doc.intro}</p>
      {doc.sections.map((s) => (
        <section key={s.h}>
          <h4>{s.h}</h4>
          {s.body.map((b, i) =>
            Array.isArray(b) ? (
              <ul key={i}>
                {b.map((li) => (
                  <li key={li}>{li}</li>
                ))}
              </ul>
            ) : (
              <p key={i}>{b}</p>
            )
          )}
        </section>
      ))}
    </div>
  )
}

/** The page in a dialog, with a switch to the other one. */
export function LegalDialog({ which: first, onClose }: { which: LegalWhich; onClose: () => void }) {
  const [which, setWhich] = useState(first)
  const other: LegalWhich = which === 'privacy' ? 'terms' : 'privacy'
  // Into the page itself: inside the sign-up card, the card would clip it.
  return createPortal(
    <Dialog title={DOCS[which].title} onClose={onClose} width={640}>
      <div className="legal-scroll">
        <LegalText which={which} />
      </div>
      <div className="actions">
        <button className="btn ghost left" onClick={() => setWhich(other)}>
          {DOCS[other].title}
        </button>
        <button className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>,
    document.body
  )
}

/** Asks the app to show a legal page from anywhere (Help menu, Settings). */
export const LEGAL_EVENT = 'veyra:legal'
export const showLegal = (which: LegalWhich) => window.dispatchEvent(new CustomEvent(LEGAL_EVENT, { detail: which }))

/** Mounted once in the app: shows the page asked for by showLegal(). */
export function LegalHost() {
  const [which, setWhich] = useState<LegalWhich | null>(null)
  useEffect(() => {
    const on = (e: Event) => setWhich(((e as CustomEvent).detail as LegalWhich) ?? 'privacy')
    window.addEventListener(LEGAL_EVENT, on)
    return () => window.removeEventListener(LEGAL_EVENT, on)
  }, [])
  return which ? <LegalDialog which={which} onClose={() => setWhich(null)} /> : null
}
