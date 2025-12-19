// Non-secret configuration managed by SST
// Values vary by stage using $app.stage

export const config = {
  // Application
  app: {
    nodeEnv: new sst.Linkable('NodeEnv', {
      properties: { value: $app.stage === 'production' ? 'production' : 'development' },
    }),
    logLevel: new sst.Linkable('LogLevel', {
      properties: { value: $app.stage === 'production' ? 'info' : 'debug' },
    }),
    port: new sst.Linkable('Port', {
      properties: { value: '3000' },
    }),
  },

  // Apple Calendar (CalDAV)
  caldav: {
    url: new sst.Linkable('CaldavUrl', {
      properties: { value: 'https://caldav.icloud.com' },
    }),
    // Username is stage-specific (set per deployment)
  },

  // Email (IMAP/SMTP)
  email: {
    imapHost: new sst.Linkable('ImapHost', {
      properties: { value: 'mail.hughes-family.org' },
    }),
    imapPort: new sst.Linkable('ImapPort', {
      properties: { value: '993' },
    }),
    smtpHost: new sst.Linkable('SmtpHost', {
      properties: { value: 'mail.hughes-family.org' },
    }),
    smtpPort: new sst.Linkable('SmtpPort', {
      properties: { value: '587' },
    }),
  },
};
