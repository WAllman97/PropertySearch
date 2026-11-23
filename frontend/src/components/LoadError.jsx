import { friendlyError } from "../lib/errors";

// Shown when a page couldn't load its data, so a failed load never looks like
// "you have no homes" (which reads as if everything's been lost).
function LoadError({ error, onRetry }) {
  return (
    <section className="card load-error" role="alert">
      <h3>Couldn't load this</h3>
      <p className="muted">{friendlyError(error, "Something went wrong loading this page.")} Your saved homes are safe.</p>
      {onRetry && (
        <button type="button" className="primary-button" onClick={onRetry}>
          Try again
        </button>
      )}
    </section>
  );
}

export default LoadError;
