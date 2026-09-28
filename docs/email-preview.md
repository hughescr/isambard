# Email draft preview (#158)

Each outbound email approval card in #admin can carry an **Open full preview** button. It opens a page that shows the draft exactly as WildDuck stores it: every header (From, To, Cc, Bcc, Reply-To, Subject, Date, Message-ID), the full plain-text body, the HTML body in a sandboxed frame, and every attachment as a download.

The page is served by a small HTTP server inside Izzy's process. It listens on `127.0.0.1` only, so nothing outside the Mac can reach it directly. At startup Izzy publishes it to your own tailnet with `tailscale serve`, at `https://<mac-name>.<tailnet>.ts.net/izzy-preview-<port>` (with the default port, `/izzy-preview-8787`). Only devices on your tailnet can open that address, and by default only your own Tailscale login is let in.

The preview is **on by default**. If anything stops it from working, Izzy logs one line saying why, cards simply have no button, and everything else carries on.

## Setup

1. **Install Tailscale** on the Mac Izzy runs on and on your phone (and any other device you approve from). Sign them all in to the same tailnet.
2. In the [Tailscale admin console](https://login.tailscale.com/admin/dns), open **DNS** and turn on **MagicDNS** and **HTTPS Certificates**.
3. Restart Izzy.

That's all. Check it by asking Izzy to draft an email to someone not on the allowlist. The approval card should have an **Open full preview** button that opens on your phone. The button appears a few seconds after startup, once the Tailscale setup below has finished; cards posted before then have none.

## What Izzy does with Tailscale

At startup, in the background (startup never waits for it; the examples use the default port, 8787):

1. Finds the Tailscale CLI: `tailscale` on `PATH`, otherwise `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
2. Runs `tailscale status --json` and checks that Tailscale is connected, that the Mac has a MagicDNS name, and that HTTPS certificates are enabled. It reads your login (the Mac owner's) from the same output.
3. Runs `tailscale serve status --json` and stops here if either:
   - **Funnel** is on for the Mac's HTTPS port. Publishing a path on a funnelled host would put previews on the public internet, and a plain `tailscale serve` on that port would also switch your Funnel off.
   - Something else already answers at Izzy's path, `/izzy-preview-8787` (or `/izzy-preview-8787/`): any handler that is not a proxy to Izzy's own `http://127.0.0.1:8787`. Izzy never replaces a mount it does not own. A leftover of its own (same path, same target, from a crash) is fine and gets replaced.
4. Starts the preview server on `127.0.0.1:8787`. If the port is taken, it stops here.
5. Runs `tailscale serve --bg --https=443 --set-path=/izzy-preview-8787 http://127.0.0.1:8787`, then `tailscale serve status --json` again to confirm the mount is there. If that check fails or times out, Izzy removes the mount it just added and stops the server, so a failed start leaves nothing behind.

Each command has a hard 5-second limit: a command still running then is sent SIGTERM (and SIGKILL a second later), and Izzy moves on without waiting for it, so neither startup nor shutdown can hang on Tailscale. Any failure is logged as one line, `Draft preview disabled; approval cards will carry no preview links`, with the reason (for example, the one telling you to turn on HTTPS certificates), and Izzy runs on without previews.

The path includes the port, so two copies of Izzy on one Mac (say the deployed one on 8787 and a development checkout with `EMAIL_PREVIEW_PORT=8788`) publish at `/izzy-preview-8787` and `/izzy-preview-8788` and never touch each other's mount. Two copies must not share a port; the second would fail to bind anyway.

Izzy only ever adds or removes its own `/izzy-preview-<port>` path on port 443. It never runs `tailscale funnel`, never touches other paths or ports you serve, and never changes any other Tailscale setting. `--bg` makes the mount survive Tailscale restarts.

At shutdown Izzy reads `tailscale serve status --json` again and, only if the path still proxies to its own port, runs `tailscale serve --https=443 --set-path=/izzy-preview-8787 off` (removing only that path); if someone has since pointed the path elsewhere, it leaves it alone and logs that it did. Then it stops the server. If Izzy crashes, the mount stays behind and points at nothing until the next start replaces it. To remove it by hand, run that same `off` command.

## Settings

All are optional environment variables, read at startup.

| Variable | Default | Meaning |
|---|---|---|
| `EMAIL_PREVIEW` | `auto` | `off` turns the preview off completely: no server, no Tailscale commands, no buttons. |
| `EMAIL_PREVIEW_PORT` | `8787` | The local port the server listens on (always `127.0.0.1`), which also names the tailnet path, `/izzy-preview-<port>`. Change it if something else uses 8787, and give each copy of Izzy on the same Mac its own port. |
| `EMAIL_PREVIEW_ALLOWED_LOGINS` | your login | Comma-separated Tailscale logins (e.g. `craig@example.com`) allowed to open previews. Replaces the default. |
| `EMAIL_PREVIEW_TTL_HOURS` | `168` | How long a link works after the draft was saved (7 days). |
| `EMAIL_PREVIEW_PUBLIC_BASE_URL` | unset | Manual mode; see below. |

The default allowlist is the login Tailscale lists for the Mac's owner. If the Mac is a tagged device, that is not you, so previews would answer 403; set `EMAIL_PREVIEW_ALLOWED_LOGINS` to your login instead. If Tailscale lists no owner login at all, Izzy disables the preview and says to set it.

### Manual mode

If you would rather publish the server yourself, set `EMAIL_PREVIEW_PUBLIC_BASE_URL` to the `https://…` address your own `tailscale serve` gives it (it must be `https`; a trailing slash is fine). Izzy then runs no Tailscale commands at all: it only starts the server on `127.0.0.1:<EMAIL_PREVIEW_PORT>` and builds links under your address. For example:

```bash
tailscale serve --bg --https=443 --set-path=/preview http://127.0.0.1:8787
EMAIL_PREVIEW_PUBLIC_BASE_URL=https://<mac-name>.<tailnet>.ts.net/preview
```

In manual mode the logins allowlist applies only if you set `EMAIL_PREVIEW_ALLOWED_LOGINS`; unset, anyone on your tailnet who has a link can open it. Use `serve`, **never `funnel`**.

## When a link stops working

A link is tied to one version of one draft. It carries a random 43-character token that is stored only in the draft's hidden WildDuck metadata and is checked on every request. The server reads the draft live from WildDuck each time and stores nothing, so restarting Izzy does not break links.

| What happened | The link now answers |
|---|---|
| Izzy edited the draft | Not found. The edited draft gets a new token, and the card's button is updated to the new link. |
| The draft was deleted or sent | Not found. |
| You approved or rejected it | "This draft has been approved or rejected." |
| The TTL passed | "Preview link expired." |
| Izzy is stopped | The page doesn't load, until Izzy is running again. |

## Security notes

- The token is the key. Anyone who has a link and passes the logins allowlist can open that draft's preview until the link stops working. Don't paste links outside Discord.
- The allowlist relies on the `Tailscale-User-Login` header that `tailscale serve` adds (it strips any copy the client sent). Any process running on the Mac itself can connect to `127.0.0.1` directly and forge that header, so the allowlist protects against other tailnet users and devices, not against software on the Mac. The token is still required either way.
- Izzy refuses to publish when Funnel is on for the Mac's HTTPS port, so previews are never reachable from the internet through its own setup.
- The draft's HTML is shown in a sandboxed frame with a strict Content-Security-Policy: it cannot run script, load remote images or reach Izzy's page. Attachments always download (never open inline) and are streamed from WildDuck without a size limit.
- Pages are marked `no-store` and `no-referrer`, so browsers neither cache them nor leak the link to other sites.
