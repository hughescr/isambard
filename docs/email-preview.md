# Email draft preview (#158)

Each outbound email approval card in #admin can carry an **Open full preview** button. It opens a page that shows the draft exactly as WildDuck stores it: every header (From, To, Cc, Bcc, Reply-To, Subject, Date, Message-ID), the full plain-text body, the HTML body in a sandboxed frame, and every attachment as a download.

The page is served by a small HTTP server inside Izzy's process. It listens on `127.0.0.1` only, so nothing outside the Mac can reach it directly. You expose it to your own devices with `tailscale serve`, which gives it an HTTPS address that only your tailnet can open. Isambard never runs Tailscale commands itself.

The preview is **off** until you configure it. With it off, cards look the same as before, without the button.

## Setup

1. **Tailscale.** Install Tailscale on the Mac Izzy runs on and on the devices you approve from, all signed in to the same tailnet. In the Tailscale admin console, open **DNS** and make sure **MagicDNS** and **HTTPS Certificates** are both enabled.

2. **Pick a port** that nothing else on the Mac uses, for example `8791`.

3. **Expose it on your tailnet** (run this on the Mac, once; `--bg` keeps it across restarts and reboots):

   ```bash
   tailscale serve --bg 8791
   tailscale serve status
   ```

   `status` prints the address, something like `https://<mac-name>.<tailnet>.ts.net/`. That is your public base URL.

   Use `serve`, **never `funnel`**. Funnel would put the previews on the public internet.

4. **Configure Izzy** with these environment variables, in the environment Izzy starts with, then restart Izzy:

   | Variable | Required | Meaning |
   |---|---|---|
   | `EMAIL_PREVIEW_PORT` | yes | The port from step 2, e.g. `8791`. |
   | `EMAIL_PREVIEW_PUBLIC_BASE_URL` | yes | The `https://…ts.net` address from step 3. It must be `https`. A trailing slash is fine. |
   | `EMAIL_PREVIEW_TTL_HOURS` | no | How long a link works after the draft was saved. Default `168` (7 days). |
   | `EMAIL_PREVIEW_ALLOWED_LOGINS` | no | Comma-separated Tailscale logins (e.g. `craig@example.com`) allowed to open previews. Unset means anyone on your tailnet who has the link. |

   Set both of the first two, or neither. Setting only one stops Izzy at startup with a configuration error that names the missing one.

5. **Check it.** Ask Izzy to draft an email to someone not on the allowlist. The approval card should have an **Open full preview** button that works on your phone and laptop. If the port is already in use, Izzy logs `Draft preview server failed to start` and cards simply have no button.

To turn the preview off, unset both variables and restart Izzy. To stop exposing it, run `tailscale serve --https=443 off` (or `tailscale serve reset` if nothing else is served).

## When a link stops working

A link is tied to one version of one draft. It carries a random 43-character token that is stored only in the draft's hidden WildDuck metadata and is checked on every request. The server reads the draft live from WildDuck each time and stores nothing, so restarting Izzy does not break links.

| What happened | The link now answers |
|---|---|
| Izzy edited the draft | Not found. The edited draft gets a new token, and the card's button is updated to the new link. |
| The draft was deleted or sent | Not found. |
| You approved or rejected it | "This draft has been approved or rejected." |
| The TTL passed | "Preview link expired." |

## Security notes

- The token is the key. Anyone on your tailnet who has a link (and passes the logins allowlist, if set) can open that draft's preview until the link stops working. Don't paste links outside Discord.
- `EMAIL_PREVIEW_ALLOWED_LOGINS` relies on the `Tailscale-User-Login` header that `tailscale serve` adds. Any process running on the Mac itself can connect to `127.0.0.1` directly and forge that header, so the allowlist protects against other tailnet users and devices, not against software on the Mac.
- The draft's HTML is shown in a sandboxed frame with a strict Content-Security-Policy: it cannot run script, load remote images or reach Izzy's page. Attachments always download (never open inline) and are streamed from WildDuck without a size limit.
- Pages are marked `no-store` and `no-referrer`, so browsers neither cache them nor leak the link to other sites.
