import { useLayoutEffect, useRef } from "react";

// A pounds field that shows commas as you type (650000 -> 650,000), so big
// numbers are easy to read. It hands onChange only the digits, in the same
// shape as a normal input's event ({ target: { value: "650000" } }), so the
// forms that use it don't change. Whole pounds only.

const digitsOf = (value) => String(value ?? "").replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "");
export const withCommas = (value) => {
  const digits = digitsOf(value);
  return digits ? Number(digits).toLocaleString("en-GB") : "";
};

export default function MoneyInput({ value, onChange, placeholder, ...rest }) {
  const ref = useRef(null);
  // Digits before the cursor after the last edit, so the cursor stays in the
  // same place when commas come and go.
  const caretDigits = useRef(null);
  const shown = withCommas(value);

  useLayoutEffect(() => {
    const input = ref.current;
    if (caretDigits.current === null || !input || document.activeElement !== input) return;
    let seen = 0;
    let pos = 0;
    while (pos < shown.length && seen < caretDigits.current) {
      if (/\d/.test(shown[pos])) seen++;
      pos++;
    }
    input.setSelectionRange(pos, pos);
    caretDigits.current = null;
  }, [shown]);

  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      value={shown}
      placeholder={placeholder && /^\d+$/.test(placeholder) ? withCommas(placeholder) : placeholder}
      onChange={(event) => {
        const { value: typed, selectionStart } = event.target;
        caretDigits.current = digitsOf(typed.slice(0, selectionStart ?? typed.length)).length;
        onChange?.({ target: { value: digitsOf(typed) } });
      }}
    />
  );
}
