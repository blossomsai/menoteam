import nodemailer from 'nodemailer';

export type InviteMail = { to: string; projectName: string; role: 'admin' | 'member'; url: string };
export type InviteMailResult = 'accepted' | 'failed' | 'unknown';

export function inviteMailConfig(env: NodeJS.ProcessEnv = process.env) {
  const { WORKBENCH_SMTP_HOST: host, WORKBENCH_SMTP_PORT: rawPort, WORKBENCH_SMTP_USER: user,
    WORKBENCH_SMTP_PASSWORD: pass, WORKBENCH_SMTP_FROM: from, WORKBENCH_ORIGIN: origin } = env;
  if (![host, rawPort, user, pass, from, origin].every(Boolean)) return undefined;
  const parsedOrigin = new URL(origin!);
  if (parsedOrigin && (parsedOrigin.protocol !== 'https:' || parsedOrigin.username || parsedOrigin.password || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.pathname !== '/' || parsedOrigin.origin !== origin!.replace(/\/$/u, ''))) {
    throw new Error('WORKBENCH_ORIGIN must be a fixed HTTPS origin');
  }
  const port = Number(rawPort);
  if (![465, 587].includes(port)) throw new Error('WORKBENCH_SMTP_PORT must be 465 or 587');
  if (!/^[^\s<>]+@[^\s<>]+$/u.test(from!)) throw new Error('WORKBENCH_SMTP_FROM must be an email address');
  return { host: host!, port, user: user!, pass: pass!, from: from!, origin: parsedOrigin!.origin };
}

export function createInviteMailer(config = inviteMailConfig()) {
  if (!config) return undefined;
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port === 587,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return async ({ to, projectName, role, url }: InviteMail): Promise<InviteMailResult> => {
    try {
      const result = await transport.sendMail({
        from: config.from,
        to,
        subject: `Invitation to ${projectName}`,
        text: `You are invited to ${projectName} as a project ${role}.\n\nAccept the invitation within two days:\n${url}`,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return result.accepted.includes(to) ? 'accepted' : 'failed';
    } catch (error) {
      const code = Number((error as { responseCode?: unknown })?.responseCode);
      return code >= 400 && code < 600 ? 'failed' : 'unknown';
    }
  };
}
