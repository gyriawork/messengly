export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[100dvh]">
      {/* Left panel — same dark indigo language as the app sidebar */}
      <div className="relative hidden w-1/2 overflow-hidden bg-gradient-to-b from-[#312e81] to-[#1e1b4b] lg:flex lg:flex-col lg:justify-between lg:p-16">
        <img src="/logo.svg" alt="Messengly" className="h-8 self-start" />

        <div className="max-w-lg">
          <h1 className="text-4xl font-semibold leading-tight text-white">
            Every chat.
            <br />
            One broadcast.
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-indigo-200">
            Bring all your messengers together in one place and send prepared
            messages to every chat at once.
          </p>
        </div>

        <p className="text-sm text-indigo-300/70">
          Built for teams that talk to hundreds of chats a day.
        </p>
      </div>

      {/* Right panel — the form */}
      <div className="flex w-full items-center justify-center bg-slate-50 px-4 lg:w-1/2">
        {children}
      </div>
    </div>
  );
}
