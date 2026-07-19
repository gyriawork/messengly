import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export const metadata: Metadata = { title: 'Terms of Service · Messengly' };

export default function TermsOfServicePage() {
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
          <h1 className="text-2xl font-semibold text-slate-900">Terms of Service</h1>
          <p className="mt-1 text-sm text-slate-500">Last updated: July 19, 2026</p>

          <div className="prose-messengly mt-8 space-y-6 text-sm leading-relaxed text-slate-700">
            <section>
              <h2 className="text-base font-semibold text-slate-900">1. Agreement to these Terms</h2>
              <p className="mt-2">
                These Terms of Service (&quot;Terms&quot;) form a binding agreement between you (and,
                where you use Messengly on behalf of a workspace or organization, that organization,
                jointly &quot;you&quot;) and Messengly (&quot;we&quot;, &quot;us&quot;,
                &quot;our&quot;). By registering for an account, or by accessing or using Messengly
                in any way, you automatically and unconditionally accept these Terms and our{' '}
                <Link href="/privacy" className="text-accent hover:underline">
                  Privacy Policy
                </Link>{' '}
                in full and agree to be bound by them, without any further action required on your
                part. If you do not agree, do not register for, access, or use the service.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">2. The service</h2>
              <p className="mt-2">
                Messengly lets a workspace connect messenger accounts (Telegram, Slack, WhatsApp,
                Gmail, Microsoft Teams) that its own members control, import chats from those
                accounts, and send prepared messages to them individually or as a broadcast. Messages
                are always sent as the connected account, not as a Messengly bot. Messengly is a
                communications tool only — we do not control, endorse, or take responsibility for the
                content of any message sent through it.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">3. Eligibility and accounts</h2>
              <p className="mt-2">
                You must be at least 18 years old and capable of forming a binding contract to use
                Messengly. Messengly is invite-only — accounts are created by a workspace admin. You
                are solely responsible for maintaining the confidentiality of your login credentials
                and for all activity that occurs under your account, whether or not authorized by you.
                You must notify us immediately of any unauthorized use of your account.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">4. Connected messenger accounts</h2>
              <p className="mt-2">
                When you connect a Telegram, Slack, WhatsApp, Gmail, or Microsoft Teams account to
                Messengly, you represent and warrant that you are the lawful owner or authorized user
                of that account, and that connecting it to Messengly and sending messages through it
                does not violate any agreement you have with that platform or any third party. You,
                and not Messengly, are solely and exclusively responsible for: (a) the content of
                every message sent through your connected accounts; (b) obtaining any consents needed
                from recipients; (c) complying with each messenger platform&apos;s own terms of
                service, developer policies, and rate limits; and (d) any consequence of that use,
                including suspension, banning, or termination of your account by that platform.
                Messengly is not affiliated with, and does not act on behalf of, Telegram, Slack,
                WhatsApp, Google, or Microsoft.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">5. Acceptable use</h2>
              <p className="mt-2">You agree that you will not, and will not permit any third party to, use Messengly to:</p>
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                <li>Send unsolicited bulk messages (spam) to recipients who have not consented to be contacted.</li>
                <li>Send content that is illegal, fraudulent, deceptive, defamatory, harassing, or infringing.</li>
                <li>Violate any messenger platform&apos;s terms of service, acceptable-use policy, or attempt to circumvent its rate limits or anti-spam systems.</li>
                <li>Infringe any third party&apos;s intellectual property, privacy, or other legal rights.</li>
                <li>Transmit malware, or attempt to gain unauthorized access to the service or another user&apos;s account or data.</li>
                <li>Use the service in violation of any applicable law, including data protection and electronic-communications law in your jurisdiction and that of your recipients.</li>
              </ul>
              <p className="mt-2">
                You are solely responsible for having a lawful basis (such as consent or an existing
                relationship) to message each recipient. We may investigate and take any action we
                consider appropriate — including suspension or termination, without prior notice —
                in response to a suspected violation of this section.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">6. Workspace admins</h2>
              <p className="mt-2">
                A workspace admin can invite and remove members, and configure permissions such as
                which members may connect their own messenger accounts or view the workspace&apos;s
                chats. Your workspace, and not Messengly, is solely responsible for how it configures
                and uses these permissions, and for the conduct of its own members.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">7. Your content</h2>
              <p className="mt-2">
                You retain all rights to the content (messages, attachments, templates) you submit to
                or send through Messengly (&quot;Your Content&quot;). You grant us a limited,
                non-exclusive, worldwide license to host, store, transmit, and process Your Content
                solely as necessary to provide the service to you. You are solely responsible for
                Your Content and represent that you have all rights necessary to submit it and to
                grant this license.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">8. Intellectual property</h2>
              <p className="mt-2">
                Messengly and its original content, features, and functionality are and will remain
                the exclusive property of Messengly and its licensors. Nothing in these Terms
                grants you any right to use our trademarks, logos, or branding without our prior
                written consent.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">9. Third-party services</h2>
              <p className="mt-2">
                The service integrates with third-party platforms (Telegram, Slack, WhatsApp, Google,
                Microsoft) that we do not own, operate, or control. We are not responsible or liable,
                directly or indirectly, for any damage or loss caused by, or in connection with, your
                use of or reliance on any such third-party platform, including any outage, policy
                change, or account action taken by that platform.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">10. Availability and changes to the service</h2>
              <p className="mt-2">
                We aim to keep Messengly available and reliable but do not guarantee uninterrupted,
                timely, secure, or error-free operation. We may modify, suspend, or discontinue any
                part of the service at any time, with or without notice, and without liability to
                you for doing so.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">11. Disclaimer of warranties</h2>
              <p className="mt-2 uppercase tracking-tight">
                The service is provided &quot;as is&quot; and &quot;as available&quot;, without
                warranties of any kind, whether express, implied, or statutory, including without
                limitation any implied warranties of merchantability, fitness for a particular
                purpose, title, non-infringement, or that the service will be uninterrupted, secure,
                or error-free. Messengly makes no warranty regarding the results that may be obtained
                from use of the service, or that any errors will be corrected.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">12. Limitation of liability</h2>
              <p className="mt-2 uppercase tracking-tight">
                To the maximum extent permitted by applicable law, in no event shall Messengly,
                its owners, directors, officers, employees, or agents be liable for any indirect,
                incidental, special, consequential, exemplary, or punitive damages, or for any loss of
                profits, revenue, data, goodwill, or other intangible losses, arising out of or
                related to your access to or use of, or inability to access or use, the service —
                including any action taken against a connected messenger account by its platform
                (such as suspension or banning) — whether based on warranty, contract, tort (including
                negligence), or any other legal theory, and whether or not we have been advised of the
                possibility of such damages. In no event shall the total aggregate liability of
                Messengly arising out of or relating to these Terms or the service exceed the
                greater of (a) the amount you paid us for the service in the twelve (12) months
                preceding the claim, or (b) one hundred euros (€100).
              </p>
              <p className="mt-2">
                Nothing in these Terms excludes or limits liability that cannot be excluded or limited
                under applicable law, including liability for death or personal injury caused by
                negligence, or fraud.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">13. Indemnification</h2>
              <p className="mt-2">
                You agree to defend, indemnify, and hold harmless Messengly, its owners,
                directors, officers, employees, and agents from and against any and all claims,
                damages, obligations, losses, liabilities, costs, and expenses (including reasonable
                legal fees) arising from: (a) Your Content or any message sent through your connected
                accounts; (b) your use of, or connection to, any messenger account through the
                service; (c) your violation of any term of these Terms; or (d) your violation of any
                third-party right, including without limitation any intellectual property,
                data-protection, or privacy right.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">14. Termination</h2>
              <p className="mt-2">
                We may suspend or terminate your access to the service at any time, with or without
                cause and with or without notice, including for violation of Section 5 (Acceptable
                use). You or your workspace admin may stop using the service, or request deletion of
                your account and data, at any time. Sections 7 through 13 and 15 through 18 survive
                any termination of these Terms.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">15. Force majeure</h2>
              <p className="mt-2">
                We will not be liable for any failure or delay in performance resulting from causes
                beyond our reasonable control, including acts of God, natural disaster, war,
                terrorism, riots, embargoes, acts of civil or military authority, fire, flood,
                accidents, epidemic, strikes, or failures or outages of third-party networks, utility,
                or messenger-platform services.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">16. Governing law and disputes</h2>
              <p className="mt-2">
                These Terms are governed by applicable law, without regard to conflict-of-law
                principles. Any dispute arising out of or relating to these Terms or the service will
                be resolved in a competent court of applicable jurisdiction.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">17. General provisions</h2>
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                <li><strong>Entire agreement.</strong> These Terms, together with our Privacy Policy, constitute the entire agreement between you and Messengly regarding the service.</li>
                <li><strong>Severability.</strong> If any provision of these Terms is held invalid or unenforceable, the remaining provisions will remain in full force and effect.</li>
                <li><strong>No waiver.</strong> Our failure to enforce any right or provision of these Terms will not be considered a waiver of that right or provision.</li>
                <li><strong>Assignment.</strong> You may not assign or transfer these Terms without our prior written consent; we may assign these Terms freely, including in connection with a merger, acquisition, or sale of assets.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">18. Changes to these Terms</h2>
              <p className="mt-2">
                We may revise these Terms from time to time. If we make material changes, we&apos;ll
                update the date at the top of this page. Your continued use of the service after any
                such change constitutes your acceptance of the revised Terms.
              </p>
            </section>

            <section>
              <h2 className="text-base font-semibold text-slate-900">19. Contact us</h2>
              <p className="mt-2">
                Questions about these Terms? Email us at{' '}
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
