import { useEffect, useRef } from "react";

// "Archived · Undo" at the bottom of the screen for a few seconds, so a slip
// of the finger costs nothing and there's no "Are you sure?" to tap through.
function UndoBar({ message, onUndo, onDone, duration = 5000 }) {
  // The latest onDone, so a parent re-render doesn't restart the timer.
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const timer = setTimeout(() => done.current?.(), duration);
    return () => clearTimeout(timer);
  }, [message, duration]);

  return (
    <div className="toast" role="status">
      <span>{message}</span>
      <button type="button" className="link-button" onClick={onUndo}>
        Undo
      </button>
    </div>
  );
}

export default UndoBar;
