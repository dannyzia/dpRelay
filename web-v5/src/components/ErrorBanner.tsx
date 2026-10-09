/**
 * Non-interactive error strip shared by every screen.
 *
 * ISSUE-91: `role="alert"` announces the failure to screen readers, and the
 * stable `id` is what forms point `aria-describedby` at while an error is
 * shown (the banner only ever renders when there IS an error).
 */
export function ErrorBanner({ message }: { message: string }): JSX.Element {
  return (
    <p id="form-error" className="error banner" role="alert">
      {message}
    </p>
  );
}
