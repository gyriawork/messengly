import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export const metadata: Metadata = { title: 'Privacy Policy · Messengly' };

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-[100dvh] bg-slate-50">
      <div className="mx-auto max-w-3xl px-4 py-10 md:px-6 md:py-16">
        <Link
          href="/login"
          className="mb-8 inline-flex items-center gap-1.5 text-sm text-slate-500 transition-colors hover:text-accent"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to sign in
        </Link>

        <div className="rounded-2xl bg-white p-8 shadow-xs md:p-12">
          <h1 className="text-2xl font-semibold text-slate-900">Privacy Policy</h1>
          <p className="mt-1 text-sm text-slate-500">Last updated: July 19, 2026</p>

          <div className="prose-messengly mt-8 space-y-6 text-sm leading-relaxed text-slate-700">
            <section>
              <h2 className="text-base font-semibold text-slate-900">1. Who we are</h2>
              <p className="mt-2">
                Messengly (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) provides a unified inbox
                and broadcast tool that lets a workspace send prepared messages through the messenger
                accounts its own members connect to it — Telegram, Slack, WhatsApp, Gmail, and
                Microsoft Teams. Where the EU General Data Protection Regulation (Regulation (EU)
                2016/679, &quot;GDPR&quot;) applies to you, we act as the data controller for the
                personal data described in this policy, which explains what we process, why, on what
                legal basis, and what rights you have over it. By registering for an account, or by
                accessing or using Messengly in any way, you automatically and unconditionally accept
                this Privacy Policy and our{' '}
                <Link href="/terms" className="text-accent hover:underline">
                  Terms of Service
                </Link>{' '}
                in full.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">2. Data we collect</h2>
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                <li>
                  <strong>Account data</strong> — name, email address, and a hashed password (or, if
                  you sign in with Google, your Google account&apos;s name, email address, and profile
                  picture).
                </li>
                <li>
                  <strong>Messenger connection data</strong> — the access tokens or session data needed
                  to send messages through the messenger accounts you or your workspace connect. These
                  are encrypted at rest and never stored in plain text.
                </li>
                <li>
                  <strong>Message and chat data</strong> — the chats you import, the messages you send
                  through Messengly, and any attachments you upload.
                </li>
                <li>
                  <strong>Usage and activity data</strong> — basic activity logs (who connected or
                  disconnected an account, who sent a broadcast) so a workspace admin can see what
                  happened in their own workspace.
                </li>
                <li>
                  <strong>Technical data</strong> — IP address, browser type, device information, and
                  server log data, collected automatically when you use the service, for security and
                  troubleshooting purposes.
                </li>
                <li>
                  <strong>Cookies</strong> — we use a small number of strictly necessary cookies (an
                  httpOnly session cookie that keeps you signed in). We do not use advertising or
                  cross-site tracking cookies.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">3. Signing in with Google</h2>
              <p className="mt-2">
                If you use &quot;Sign in with Google&quot;, we request only your name, email address,
                and profile picture (the standard <code>openid</code>, <code>email</code>, and{' '}
                <code>profile</code> scopes). We use this solely to look up and authenticate an
                existing Messengly account that matches your email address — Messengly has no
                self-registration, so signing in with Google never creates a new account on its own.
                We do not request or access your Gmail, Google Drive, Google Contacts, or any other
                Google data through this sign-in flow, and we do not share your Google profile data
                with any third party. (Messengly&apos;s separate Gmail integration, used only if you
                explicitly connect a Gmail account under Settings, is a distinct feature governed by
                the permissions you grant it at connection time.)
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">4. Legal basis for processing (GDPR)</h2>
              <p className="mt-2">We process your personal data on the following legal bases:</p>
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                <li>
                  <strong>Performance of a contract</strong> (Art. 6(1)(b) GDPR) — to create your
                  account, authenticate you, and provide the core service you or your workspace signed
                  up for.
                </li>
                <li>
                  <strong>Legitimate interests</strong> (Art. 6(1)(f) GDPR) — to keep the service
                  secure, prevent abuse, and maintain basic activity logs for your workspace admins.
                </li>
                <li>
                  <strong>Consent</strong> (Art. 6(1)(a) GDPR) — where you actively choose to connect a
                  third-party messenger account or sign in with Google; you can withdraw this consent
                  at any time by disconnecting that account.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">5. How we use your data</h2>
              <p className="mt-2">We use the data above only to:</p>
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                <li>Authenticate you and keep your session secure.</li>
                <li>Send messages through the messenger accounts you&apos;ve connected, on your instruction.</li>
                <li>Display your chats, message history, and broadcast results back to you.</li>
                <li>Operate basic anti-spam pacing so your connected accounts aren&apos;t flagged by the messenger platforms themselves.</li>
                <li>Maintain the security, integrity, and availability of the service.</li>
              </ul>
              <p className="mt-2">
                We do not sell your personal data, and we do not use your messages or contacts for
                advertising or profiling.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">6. How we protect your data</h2>
              <p className="mt-2">
                Messenger credentials and session tokens are encrypted at rest (AES-256-GCM) and are
                never stored or transmitted in plain text. Passwords are hashed, never stored in
                plain text. Every workspace&apos;s data is isolated from every other workspace.
                Access to a workspace&apos;s data is limited to that workspace&apos;s own members,
                subject to the roles and permissions its admins configure. We use industry-standard
                infrastructure providers that maintain their own security certifications.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">7. Data sharing and processors</h2>
              <p className="mt-2">
                We share data only where necessary to provide the service:
              </p>
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                <li>
                  With the messenger platforms you explicitly connect (Telegram, Slack, WhatsApp,
                  Google, Microsoft), strictly to carry out the actions you request — for example,
                  sending a message you composed.
                </li>
                <li>
                  With infrastructure and hosting sub-processors (such as our cloud hosting, database,
                  and file storage providers) who process data solely on our instructions and under
                  contractual confidentiality obligations, to operate the service.
                </li>
                <li>
                  Where required by law, regulation, legal process, or governmental request.
                </li>
              </ul>
              <p className="mt-2">
                We do not share your data with data brokers or advertisers, and we do not sell
                personal data.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">8. International data transfers</h2>
              <p className="mt-2">
                Some of our infrastructure providers may process data outside the European Economic
                Area. Where this happens, we rely on appropriate safeguards recognized under GDPR,
                such as the European Commission&apos;s Standard Contractual Clauses, or providers
                certified under an equivalent adequacy framework.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">9. Data retention and deletion</h2>
              <p className="mt-2">
                We retain your data for as long as your account is active and as necessary to provide
                the service. If you disconnect a messenger account, its credentials are removed; the
                chats and message history already imported remain unless you delete them. You or your
                workspace admin can request deletion of your account and associated data at any time
                by contacting us below; we will delete or anonymize it within a reasonable period,
                except where we are required to retain it by law.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">10. Your rights under GDPR</h2>
              <p className="mt-2">If you are located in the EU/EEA, UK, or another jurisdiction with similar protections, you have the right to:</p>
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                <li><strong>Access</strong> the personal data we hold about you.</li>
                <li><strong>Rectify</strong> inaccurate or incomplete data.</li>
                <li><strong>Erase</strong> your data (&quot;right to be forgotten&quot;), subject to legal exceptions.</li>
                <li><strong>Restrict</strong> or <strong>object to</strong> certain processing.</li>
                <li><strong>Port</strong> your data to another provider in a structured, machine-readable format.</li>
                <li><strong>Withdraw consent</strong> at any time, where processing is based on consent.</li>
                <li>
                  <strong>Lodge a complaint</strong> with your local data protection supervisory
                  authority.
                </li>
              </ul>
              <p className="mt-2">
                To exercise any of these rights, contact us at the address below. We will respond
                within the timeframes required by applicable law.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">11. Children&apos;s privacy</h2>
              <p className="mt-2">
                Messengly is a business tool and is not directed at, or intended for use by, children
                under 16. We do not knowingly collect personal data from children.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">12. Changes to this policy</h2>
              <p className="mt-2">
                We may update this policy from time to time. If we make material changes, we&apos;ll
                update the date at the top of this page and, where appropriate, notify workspace
                admins directly.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">13. Contact us</h2>
              <p className="mt-2">
                Questions about this policy, or requests regarding your personal data? Email us at{' '}
                <a href="mailto:support@messengly.app" className="text-accent hover:underline">
                  support@messengly.app
                </a>
                .
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
