# Mid-Term Roadmap

## Goals
Expand integrations and information sources.

## Read-Only Integrations
Priority order for adding read-only access to external services:

### Email Access (Completed February 2026)
- [x] IMAP connection (imapflow) with IDLE push support
- [x] Inbox read queries with CleanInbox management and IMAP IDLE
- [x] MCP tools for email context (checkInbox, getEmailContent, archiveEmail, searchEmail)
- [x] Outbound email via WildDuck HTTP API with admin approval workflow (sendEmail, replyToEmail, amendAndResubmitDraft, deleteDraft)
- [x] Allowlist-based access control for outbound sending
- [x] Token bucket rate limiter for outbound sends

### Social & Content Feeds
- [ ] Bluesky integration (AT Protocol)
- [ ] RSS feed aggregation
- [ ] MCP tools for feed context

## Self-Modification
- [ ] PR generation workflow
- [ ] Safety validation checks
- [ ] GitHub integration for PRs

## Future Write Capabilities
After read-only integrations are stable:
- [ ] Calendar event creation
- [x] Email sending (via WildDuck HTTP API, not nodemailer)
- [ ] Bluesky posting
- [ ] Box Documents (box-node-sdk)

## Success Criteria
- Read-only integrations functional with tests
- Self-modification creates valid PRs
- Autonomous perch time cycles operational
