# Welcome page

The Welcome page runs on a fresh local installation to help you verify an agent, optionally import existing projects and conversations, and connect the mobile app. Only one ready agent is required to start.

- Reopen it anytime from **Settings → About → Welcome page → Open**.
- Hosted `app.t3.codes` skips this page and prompts you to sign in to T3 Connect and run `t3 connect` on your computer instead.

## Agents

T3 Code lists detected agents first (ready ones on top), followed by **Add more agents** for all other supported providers:

- **Turn on**: Enables a disabled provider and checks its install and sign-in status.
- **Claude Code**: **Install** or **Sign in** opens a setup terminal using the vendor's installer (so **Update now** keeps working in Settings).
- **Codex**: **Set up** offers ChatGPT sign-in or your existing Codex CLI.
- **Outdated or other agents**: **Update** or selecting the agent opens its page in **Settings → Providers**. **Browse** opens the ACP Registry.
- **Desktop CLI**: Click **Add to PATH** if the `t3` command isn't yet on your shell `PATH`.

Click **Start** once at least one agent is ready, or **Start without an agent** to enter the app immediately (checked projects still import).

## Phone

Select **Set up** to scan the QR code for iOS or Android, then sign in to T3 Connect on both devices. If T3 Connect is unavailable or disabled by policy, pair with a code from **Settings → Sharing & access**.

## Projects and conversation import

T3 Code scans directories used by Claude Code, Codex, and Pi (turn on Pi under **Add more agents** to include Pi sessions).

- Git repositories active in the last 30 days with at least three conversations are pre-selected (excluding already-added projects, Codex scratch directories, and `Downloads`). Use **Review all** to customize the selection.
- Conversations active in the last 30 days are imported so you can continue them in T3 Code.

### Import limits

Conversation import is best-effort:

Conversation import is best effort. T3 Code keeps the first user prompt and the
newest remaining visible user and assistant messages, with 200 messages total.
It omits tool activity and attachments. For Codex, it omits generated setup
context only when a canonical user event and a valid shared turn ID identify the
same user turn. Ambiguous legacy or response-only context stays in the imported
conversation so T3 Code does not remove user text. For Claude, slash commands
and `!` shell commands appear as you typed them; their output, background task
notifications and interruption markers are left out, and a conversation that
only ran commands such as `/clear`, with no reply, is skipped. It reads one
conversation at a time and skips files larger than 4 GiB. It also skips a conversation when the
message text and metadata it keeps need more than 32 MiB of memory. Tool output
does not count toward that limit. It skips a conversation with more than 100,000
records every time, so opening the page again does not import it. It ignores
malformed records and conversations with no messages, such as a session opened
in an editor but never used. It skips unreadable or unparseable conversations.

Each import attempt reads up to 100 conversations and 4 GiB per project.
Conversations with no messages count toward the 4 GiB but not the 100. To
continue a large batch, open the Welcome page again and pick the project in
**Review all**. Completed conversations are not imported again. You can continue
without the remaining history.

Imported Claude conversations stay in sync while you keep using Claude Code
outside T3 Code: new messages appear in the thread within a few seconds, including
after you have also used the thread in T3 Code. In projects that already have imported conversations, new Claude Code
conversations are picked up about once a minute. Codex and Pi conversations are
imported once.

You can start without importing. While an import runs, T3 Code stays on the
Welcome page. If you quit, open the Welcome page again from **Settings → About**; the
projects you started stay checked.
