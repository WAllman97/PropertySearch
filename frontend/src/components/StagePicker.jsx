import { useEffect, useId, useRef, useState } from "react";

// Where a saved home is up to, in order. One button shows the current stage
// ("Viewed ▾"); tapping it lists them all, with Archive set apart at the end,
// so changing stage is one tap to open and one to choose.
export const STAGES = [
  { key: "favourite", label: "Favourite" },
  { key: "viewing_booked", label: "Viewing booked" },
  { key: "viewed", label: "Viewed" },
  { key: "offer_considered", label: "Offer considered" },
  { key: "offer_made", label: "Offer made" },
  { key: "offer_accepted", label: "Offer accepted" },
];

export function stageLabel(status) {
  if (status === "archived") return "Archived";
  return STAGES.find((s) => s.key === status)?.label || "Saved";
}

// onChoose(key) is called with a stage key or "archived".
function StagePicker({ status, onChoose, disabled = false, className = "" }) {
  const [open, setOpen] = useState(false);
  // Open towards the middle of the screen, so a right-hand tile's list
  // doesn't run off the edge of a phone.
  const [alignRight, setAlignRight] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const listRef = useRef(null);
  const listId = useId();

  function toggle(event) {
    event.stopPropagation();
    if (!open) {
      const rect = buttonRef.current?.getBoundingClientRect();
      setAlignRight(Boolean(rect && rect.left > window.innerWidth / 2));
    }
    setOpen(!open);
  }

  function close({ refocus = true } = {}) {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return undefined;
    // Keyboard and screen-reader users land on the current stage.
    const current = listRef.current?.querySelector("[aria-current='true']") || listRef.current?.querySelector("button");
    current?.focus();
    listRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });

    const onPointer = (event) => {
      if (!wrapRef.current?.contains(event.target)) close({ refocus: false });
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        return;
      }
      // Arrow keys move through the list, like a menu.
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const buttons = [...(listRef.current?.querySelectorAll("button") || [])];
        const at = buttons.indexOf(document.activeElement);
        if (at === -1) return;
        event.preventDefault();
        const next = event.key === "ArrowDown" ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length;
        buttons[next].focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function choose(key) {
    close();
    if (key !== status) onChoose(key);
  }

  return (
    <div className={`stage-picker ${className}`} ref={wrapRef} onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        ref={buttonRef}
        className={`stage-button stage-${status}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Stage: ${stageLabel(status)}. Change stage`}
        disabled={disabled}
        onClick={toggle}
      >
        {stageLabel(status)} <span aria-hidden="true">▾</span>
      </button>

      {open && (
        <ul id={listId} ref={listRef} className={`stage-list${alignRight ? " align-right" : ""}`} aria-label="Move to stage">
          {STAGES.map((stage) => {
            const current = stage.key === status;
            return (
              <li key={stage.key}>
                <button type="button" aria-current={current ? "true" : undefined} onClick={() => choose(stage.key)}>
                  <span className="stage-tick" aria-hidden="true">
                    {current ? "✓" : ""}
                  </span>
                  {stage.label}
                </button>
              </li>
            );
          })}
          <li className="stage-list-archive">
            <button type="button" onClick={() => choose("archived")}>
              <span className="stage-tick" aria-hidden="true" />
              Archive
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

export default StagePicker;
