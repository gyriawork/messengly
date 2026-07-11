// Remounts on every route change (unlike layout), which is what restarts the
// enter animation. Fade only: a transform here would become the containing
// block for the app's position:fixed modals.
export default function DashboardTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="h-full motion-safe:animate-overlay-in">{children}</div>;
}
