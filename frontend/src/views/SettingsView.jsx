import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import BookingSettings from "../components/BookingSettings";
import BuyerPositionSettings from "../components/BuyerPositionSettings";
import { DeleteBuyerAccount, HouseholdMembers } from "../components/HouseholdSettings";
import BuyerSearches from "../components/BuyerSearches";
import BuyerProfileSettings from "../components/BuyerProfileSettings";
import NotificationSettings from "../components/NotificationSettings";
import PushSettings from "../components/PushSettings";
import { isNativeApp } from "../lib/platform";

function SettingsView({ user }) {
  const [household, setHousehold] = useState(null);

  const loadHousehold = useCallback(async () => {
    const { data, error } = await supabase.rpc("my_household");
    if (error) console.error("Could not load household:", error);
    else setHousehold(data);
  }, []);

  useEffect(() => {
    if (user) loadHousehold();
  }, [user, loadHousehold]);

  if (!user) {
    return (
      <section className="card">
        <div className="section-header">
          <h2>Settings</h2>
          <p>Please log in to manage your saved searches.</p>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="card">
        <div className="section-header">
          <h2>What you're looking for</h2>
          <p>
            Agents' new listings that fit one of these searches are sent
            straight to you.
          </p>
        </div>

        <BuyerSearches user={user} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>Your Buying Position</h2>
          <p>
            Agents prioritise buyers who can move quickly. Shared with the
            agents you book viewings or make offers with.
          </p>
        </div>

        <BuyerPositionSettings />
      </section>

      {household && (
        <section className="card">
          <div className="section-header">
            <h2>Household</h2>
            <p>Everyone here shares one property list, calendar and notes.</p>
          </div>

          <HouseholdMembers household={household} onChange={loadHousehold} />
        </section>
      )}

      {isNativeApp && (
        <section className="card">
          <div className="section-header">
            <h2>Phone Notifications</h2>
          </div>

          <PushSettings />
        </section>
      )}

      <section className="card">
        <div className="section-header">
          <h2>Agent Booking Page</h2>
          <p>
            Give agents this link instead of your number. They pick a free
            slot for a call or viewing, you accept it, and it lands in your
            calendar.
          </p>
        </div>

        <BookingSettings user={user} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>Buyer Profile & Commute</h2>
          <p>
            Add commute locations, choose your preferred travel method, and
            refresh commute times.
          </p>
        </div>

        <BuyerProfileSettings user={user} />
      </section>

      {/* The daily alert email comes from the scraper, which only works
          for the original household (migration 013). */}
      {household?.is_original && (
        <section className="card">
          <div className="section-header">
            <h2>Email Notifications</h2>
            <p>
              Choose how often you receive property alerts and add extra
              recipients, such as your partner.
            </p>
          </div>

          <NotificationSettings user={user} />
        </section>
      )}

      {household && (
        <section className="card">
          <div className="section-header">
            <h2>Delete Account</h2>
          </div>

          <DeleteBuyerAccount household={household} />
        </section>
      )}
    </>
  );
}

export default SettingsView;