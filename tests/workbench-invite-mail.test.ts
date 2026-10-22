import { beforeEach, describe, expect, it, vi } from 'vitest';

const {sendMail}=vi.hoisted(()=>({sendMail:vi.fn()}));
vi.mock('nodemailer',()=>({default:{createTransport:vi.fn(()=>({sendMail}))}}));
import nodemailer from 'nodemailer';
import { createInviteMailer, inviteMailConfig } from '../src/workbench/invite-mail.js';

const env={WORKBENCH_SMTP_HOST:'smtp.example.test',WORKBENCH_SMTP_PORT:'587',WORKBENCH_SMTP_USER:'fixture-user',WORKBENCH_SMTP_PASSWORD:'fixture-password',WORKBENCH_SMTP_FROM:'invites@example.test',WORKBENCH_ORIGIN:'https://workbench.example.test'};

beforeEach(()=>{sendMail.mockReset();vi.mocked(nodemailer.createTransport).mockClear();});

describe('project invitation SMTP',()=>{
  it.each([
    ['accepted',{accepted:['person@example.test'],rejected:[]},'accepted'],
    ['definite SMTP rejection',Object.assign(new Error('rejected'),{responseCode:550}),'failed'],
    ['timeout ambiguity',Object.assign(new Error('socket timeout'),{code:'ETIMEDOUT'}),'unknown'],
  ] as const)('classifies %s without overstating delivery',async(_label,outcome,expected)=>{
    sendMail.mockImplementationOnce(()=>outcome instanceof Error?Promise.reject(outcome):Promise.resolve(outcome));
    const config=inviteMailConfig(env)!;const send=createInviteMailer(config)!;
    await expect(send({to:'person@example.test',projectName:'Atlas',role:'admin',url:'https://workbench.example.test/workbench/?invite=token'})).resolves.toBe(expected);
    const options=vi.mocked(nodemailer.createTransport).mock.calls[0]![0];
    expect(options).toMatchObject({host:env.WORKBENCH_SMTP_HOST,port:587,secure:false,requireTLS:true,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000,logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true,auth:{user:env.WORKBENCH_SMTP_USER,pass:env.WORKBENCH_SMTP_PASSWORD}});
    const message=sendMail.mock.calls[0]![0];
    expect(message).toMatchObject({from:env.WORKBENCH_SMTP_FROM,to:'person@example.test',subject:'Invitation to Atlas'});
    expect(message.text).toContain('project admin');expect(message.text).toContain('two days');expect(message.text).toContain('https://workbench.example.test/workbench/?invite=token');
    expect(message).not.toHaveProperty('html');expect(message).not.toHaveProperty('attachments');expect(message).not.toHaveProperty('cc');expect(message).not.toHaveProperty('bcc');
  });

  it('requires a fixed HTTPS origin and only supported TLS ports',()=>{
    expect(()=>inviteMailConfig({...env,WORKBENCH_ORIGIN:'https://user:pass@example.test'})).toThrow('fixed HTTPS origin');
    expect(()=>inviteMailConfig({...env,WORKBENCH_ORIGIN:'https://example.test/path'})).toThrow('fixed HTTPS origin');
    expect(()=>inviteMailConfig({...env,WORKBENCH_SMTP_PORT:'2525'})).toThrow('465 or 587');
    expect(inviteMailConfig({})).toBeUndefined();
  });

  it('uses implicit TLS on port 465 without disabling certificate checks',()=>{
    createInviteMailer(inviteMailConfig({...env,WORKBENCH_SMTP_PORT:'465'})!);
    const options=vi.mocked(nodemailer.createTransport).mock.calls[0]![0];
    expect(options).toMatchObject({port:465,secure:true,requireTLS:false});
    expect(options).not.toHaveProperty('tls.rejectUnauthorized',false);
  });
});
