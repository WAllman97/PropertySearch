import { useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { calculateOverallScore } from "../utils/propertyScoring";

function PropertyScoreEditor({ property, onUpdate }) {
  const [scores, setScores] = useState({
    score_location: property.score_location || 5,
    score_quality: property.score_quality || 5,
    score_commute: property.score_commute || 5,
    score_value: property.score_value || 5,
    score_future_fit: property.score_future_fit || 5,
    score_gut_feel: property.score_gut_feel || 5,
    offer_interest: property.offer_interest || "Maybe",
  });

  async function saveScores() {
    const overall = calculateOverallScore(scores);

    const { error } = await supabase
      .from("properties")
      .update({
        ...scores,
        overall_score: overall,
      })
      .eq("id", property.id);

    if (error) {
      console.error(error);
      alert("Failed to save scores");
      return;
    }

    if (onUpdate) {
      onUpdate();
    }
  }

  function renderSlider(label, field, helperText) {
    return (
      <div className="score-row">
        <div className="slider-header">
          <div>
            <span>{label}</span>
            {helperText && <p>{helperText}</p>}
          </div>

          <strong>{scores[field]}/10</strong>
        </div>

        <input
          type="range"
          min="1"
          max="10"
          value={scores[field]}
          onChange={(e) =>
            setScores({
              ...scores,
              [field]: Number(e.target.value),
            })
          }
        />

        <div className="slider-scale">
          <span>Weak</span>
          <span>Excellent</span>
        </div>
      </div>
    );
  }

  return (
    <div className="score-editor">
      <div className="score-editor-header">
        <div>
          <h3>Property Score</h3>
          <p>Score this property across the factors that actually matter.</p>
        </div>

        <div className="overall-score-pill">
          {calculateOverallScore(scores)}/100
        </div>
      </div>

      {renderSlider("Location", "score_location", "Area, feel, amenities, safety")}
      {renderSlider("Property Quality", "score_quality", "Layout, light, storage, garden, noise")}
      {renderSlider("Commute", "score_commute", "Work, partner commute, transport links")}
      {renderSlider("Value", "score_value", "Price versus alternatives and potential upside")}
      {renderSlider("Future Fit", "score_future_fit", "5+ year suitability, space, schools, flexibility")}
      {renderSlider("Gut Feel", "score_gut_feel", "Not included in the overall score")}

      <div className="offer-interest-row">
        <label>Would I make an offer?</label>

        <select
          value={scores.offer_interest}
          onChange={(e) =>
            setScores({
              ...scores,
              offer_interest: e.target.value,
            })
          }
        >
          <option>No</option>
          <option>Maybe</option>
          <option>Yes</option>
        </select>
      </div>

      <button type="button" className="primary-button" onClick={saveScores}>
        Save Scores
      </button>
    </div>
  );
}

export default PropertyScoreEditor;