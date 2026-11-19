import { useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

// One document backing up the buying position (migration 017): a mortgage
// agreement in principle, a full mortgage offer, or proof of funds. Stored
// privately in the household's folder; agents can open the current one only
// on the same terms as the position itself.

export const PROOF_BUCKET = "position-proofs";
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
};

// Open a private document in a new tab. The tab is opened before the
// signed link is fetched, so browsers don't treat it as a pop-up.
export async function openProof(path) {
  const tab = window.open("", "_blank");
  const { data, error } = await supabase.storage.from(PROOF_BUCKET).createSignedUrl(path, 120);
  if (error || !data?.signedUrl) {
    tab?.close();
    window.alert("Couldn't open the document. It may have been replaced or removed.");
    return;
  }
  if (tab) tab.location.href = data.signedUrl;
  else window.location.href = data.signedUrl;
}

export function proofLabel(position) {
  if (position.buying_with === "cash") return "proof of funds";
  if (position.mortgage_status === "offer") return "mortgage offer";
  return "agreement in principle";
}

function PositionProof({ position, ensurePosition, onChanged }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const what = proofLabel(position);

  async function upload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setMessage("");

    const ext = TYPES[file.type];
    if (!ext) {
      setMessage("Upload a PDF, or a photo (JPEG, PNG or HEIC).");
      return;
    }
    if (file.size > MAX_BYTES) {
      setMessage("That file is over 10 MB. Try a PDF, or a smaller photo.");
      return;
    }

    setBusy(true);
    try {
      const householdId = await ensurePosition();
      const path = `${householdId}/${crypto.randomUUID()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from(PROOF_BUCKET)
        .upload(path, file, { contentType: file.type, upsert: false });
      if (uploadError) throw uploadError;

      const { error: saveError } = await supabase
        .from("buyer_positions")
        .update({
          proof_path: path,
          proof_name: file.name.slice(0, 200),
          proof_uploaded_at: new Date().toISOString(),
        })
        .eq("household_id", householdId);
      if (saveError) {
        await supabase.storage.from(PROOF_BUCKET).remove([path]);
        throw saveError;
      }

      // Replaced: delete the old one so it can't be opened any more.
      if (position.proof_path && position.proof_path !== path) {
        await supabase.storage.from(PROOF_BUCKET).remove([position.proof_path]);
      }
      setMessage("Uploaded.");
      onChanged();
    } catch (error) {
      console.error("Proof upload failed:", error);
      setMessage("Upload failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Remove this document? Agents will no longer be able to open it.")) return;
    setBusy(true);
    setMessage("");
    const { error } = await supabase
      .from("buyer_positions")
      .update({ proof_path: null, proof_name: null, proof_uploaded_at: null })
      .eq("household_id", position.household_id);
    if (!error) await supabase.storage.from(PROOF_BUCKET).remove([position.proof_path]);
    setBusy(false);
    if (error) {
      setMessage("Couldn't remove it. Please try again.");
      return;
    }
    onChanged();
  }

  return (
    <div className="position-proof">
      <h4>Proof for agents (optional)</h4>
      {position.proof_path ? (
        <div className="proof-row">
          <span>
            📄 <strong>{position.proof_name || "Document"}</strong>
            <span className="muted">
              {" "}
              · uploaded{" "}
              {new Date(position.proof_uploaded_at).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
              })}
            </span>
          </span>
          <span className="proof-actions">
            <button type="button" className="link-button" disabled={busy} onClick={() => openProof(position.proof_path)}>
              View
            </button>
            <button type="button" className="link-button" disabled={busy} onClick={() => inputRef.current?.click()}>
              Replace
            </button>
            <button type="button" className="link-button" disabled={busy} onClick={remove}>
              Remove
            </button>
          </span>
        </div>
      ) : (
        <>
          <p className="muted">
            Attach your {what} (PDF or photo, up to 10 MB). Agents you book with can open it, so
            they know you're good for it. Cover anything you'd rather not share, such as account
            numbers.
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? "Uploading..." : `Upload ${what}`}
          </button>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/heic"
        hidden
        onChange={upload}
      />
      {message && <p className="muted">{message}</p>}
    </div>
  );
}

export default PositionProof;
