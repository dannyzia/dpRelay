/** Non-interactive error strip shared by every screen. */
export function ErrorBanner({ message }: { message: string }): JSX.Element {
  return (
    <p className="error banner" role="alert">
      {message}
    </p>
  );
}
