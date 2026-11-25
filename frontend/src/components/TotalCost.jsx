import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

// What a home would really cost the household: stamp duty, the deposit, the
// monthly mortgage and how it sits against their budget. Inputs come from
// Settings → Buying position (buyer_positions, migrations 015 and 036). It's
// an estimate, and every screen that shows it says so.

// Stamp duty (SDLT) on a home in England, standard residential rates from
// 1 April 2025. Each band's rate applies only to the slice of the price
// inside it. Update these when the government changes the rates.
export const STAMP_DUTY = {
  standard: [
    { upTo: 125000, rate: 0 },
    { upTo: 250000, rate: 0.02 },
    { upTo: 925000, rate: 0.05 },
    { upTo: 1500000, rate: 0.1 },
    { upTo: Infinity, rate: 0.12 },
  ],
  // First-time buyer relief: only when the price is £500,000 or less.
  // Above that, first-time buyers pay the standard rates.
  firstTime: {
    maxPrice: 500000,
    bands: [
      { upTo: 300000, rate: 0 },
      { upTo: 500000, rate: 0.05 },
    ],
  },
};

// Used until the buyer sets their own in Settings.
export const DEFAULT_MORTGAGE_RATE = 4.5;
export const DEFAULT_MORTGAGE_TERM = 25;
// No deposit given: assume 10%, a common minimum.
const ASSUMED_DEPOSIT_SHARE = 0.1;

function bandTax(price, bands) {
  let tax = 0;
  let from = 0;
  for (const band of bands) {
    if (price <= from) break;
    tax += (Math.min(price, band.upTo) - from) * band.rate;
    from = band.upTo;
  }
  return Math.round(tax);
}

// { amount, relief } where relief says whether first-time buyer rates applied.
export function stampDuty(price, firstTimeBuyer = false) {
  if (!price || price <= 0) return { amount: 0, relief: false };
  if (firstTimeBuyer && price <= STAMP_DUTY.firstTime.maxPrice) {
    return { amount: bandTax(price, STAMP_DUTY.firstTime.bands), relief: true };
  }
  return { amount: bandTax(price, STAMP_DUTY.standard), relief: false };
}

// Standard repayment mortgage: the same payment every month for the term.
export function monthlyRepayment(loan, ratePercent, years) {
  if (!loan || loan <= 0 || !years) return 0;
  const months = years * 12;
  const r = ratePercent / 100 / 12;
  if (!r) return loan / months;
  return (loan * r) / (1 - Math.pow(1 + r, -months));
}

// Has this household said they're a first-time buyer? The explicit setting
// (036) wins; before it's set, "first-time buyer" as their selling status.
export function isFirstTimeBuyer(position) {
  if (position?.first_time_buyer != null) return position.first_time_buyer;
  return position?.selling_status === "first_time";
}

// Everything the cost line and breakdown need, or null with no price.
export function estimateCost(price, position) {
  const value = Number(price);
  if (!value || value <= 0) return null;
  const cash = position?.buying_with === "cash";
  const hasDeposit = position?.deposit != null && position.deposit !== "";
  const deposit = cash
    ? value
    : Math.min(value, hasDeposit ? Number(position.deposit) : Math.round(value * ASSUMED_DEPOSIT_SHARE));
  const rate = Number(position?.mortgage_rate ?? DEFAULT_MORTGAGE_RATE);
  const term = Number(position?.mortgage_term_years ?? DEFAULT_MORTGAGE_TERM);
  const loan = Math.max(0, value - deposit);
  const duty = stampDuty(value, isFirstTimeBuyer(position));
  const budget = position?.max_budget ? Number(position.max_budget) : null;
  return {
    price: value,
    cash,
    deposit,
    depositAssumed: !cash && !hasDeposit,
    loan,
    rate,
    term,
    monthly: Math.round(monthlyRepayment(loan, rate, term)),
    stampDuty: duty.amount,
    relief: duty.relief,
    upfront: deposit + duty.amount,
    budget,
    overBudget: budget ? value - budget : null,
  };
}

const pounds = (n) => `£${Math.round(n).toLocaleString("en-GB")}`;

// The household's buying position, for cost estimates. null until loaded,
// {} when there isn't one (estimates then use the defaults).
export function useBuyerPosition() {
  const [position, setPosition] = useState(null);
  useEffect(() => {
    let live = true;
    // select("*") so this still works before migration 036 adds the columns.
    supabase
      .from("buyer_positions")
      .select("*")
      .maybeSingle()
      .then(({ data }) => {
        if (live) setPosition(data || {});
      });
    return () => {
      live = false;
    };
  }, []);
  return position;
}

// One line, "≈ £2,310/month · £22,500 stamp duty", which opens the breakdown.
function TotalCost({ price, position, onOpenSettings }) {
  const [open, setOpen] = useState(false);
  const cost = estimateCost(price, position);
  if (!cost) return null;

  const headline = cost.cash
    ? `≈ ${pounds(cost.stampDuty)} stamp duty · cash`
    : `≈ ${pounds(cost.monthly)}/month · ${pounds(cost.stampDuty)} stamp duty`;

  return (
    <div className="total-cost">
      <button
        type="button"
        className="total-cost-line"
        aria-expanded={open}
        onClick={(event) => {
          // Inside tiles and cards: don't also trigger them.
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        <span>{headline}</span>
        <span className="total-cost-tag">Estimate {open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="total-cost-breakdown">
          <dl>
            <dt>Price</dt>
            <dd>{pounds(cost.price)}</dd>
            {!cost.cash && (
              <>
                <dt>Deposit{cost.depositAssumed ? " (assumed 10%)" : ""}</dt>
                <dd>{pounds(cost.deposit)}</dd>
                <dt>Mortgage</dt>
                <dd>{pounds(cost.loan)}</dd>
                <dt>
                  Monthly repayment ({cost.rate}%, {cost.term} years)
                </dt>
                <dd>{pounds(cost.monthly)}</dd>
              </>
            )}
            <dt>Stamp duty{cost.relief ? " (first-time buyer rates)" : ""}</dt>
            <dd>{pounds(cost.stampDuty)}</dd>
            <dt>Cash needed up front</dt>
            <dd>{pounds(cost.upfront)}</dd>
            {cost.budget && (
              <>
                <dt>Your budget</dt>
                <dd className={cost.overBudget > 0 ? "over" : "under"}>
                  {cost.overBudget > 0
                    ? `${pounds(cost.overBudget)} over`
                    : cost.overBudget === 0
                      ? "Exactly on budget"
                      : `${pounds(-cost.overBudget)} under`}
                </dd>
              </>
            )}
          </dl>
          <p className="muted small">
            An estimate: England stamp duty rates from April 2025, a repayment mortgage, and no solicitor,
            survey or lender fees.{" "}
            {onOpenSettings && (
              <button type="button" className="link-button" onClick={onOpenSettings}>
                Change your deposit, rate or term
              </button>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

export default TotalCost;
