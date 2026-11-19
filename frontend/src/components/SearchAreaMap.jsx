import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Map for a buyer search's area (migration 016): shows the circle for
// "within X of a place", or lets the buyer tap points to draw an area.
// Loaded lazily so Leaflet only downloads when a search is being edited.

// OpenStreetMap's own tiles are fine for light use. For launch, set
// VITE_MAP_TILE_URL (and VITE_MAP_ATTRIBUTION) to a provider such as MapTiler.
const TILE_URL = import.meta.env.VITE_MAP_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION =
  import.meta.env.VITE_MAP_ATTRIBUTION ||
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const DEFAULT_CENTRE = [51.462, -0.168]; // Battersea / Wandsworth
const COLOUR = "#223a33";

function SearchAreaMap({ mode, center, radiusM, polygon, onMapClick }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const clickRef = useRef(onMapClick);
  clickRef.current = onMapClick;

  // Create the map once.
  useEffect(() => {
    const map = L.map(containerRef.current, { zoomControl: true }).setView(DEFAULT_CENTRE, 12);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    map.on("click", (event) => clickRef.current?.({ lat: event.latlng.lat, lng: event.latlng.lng }));
    mapRef.current = map;
    // A saved drawn area: start zoomed to it. (Not while drawing: the map
    // would jump about under the buyer's finger.)
    if (mode === "polygon" && polygon.length >= 3) {
      map.fitBounds(L.latLngBounds(polygon), { padding: [20, 20] });
    }
    // The form may still be laying out when the map is created.
    const timer = setTimeout(() => map.invalidateSize(), 150);
    return () => {
      clearTimeout(timer);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Redraw the circle or the drawn area.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    if (mode === "circle" && center) {
      const circle = L.circle([center.lat, center.lng], {
        radius: radiusM,
        color: COLOUR,
        weight: 2,
        fillOpacity: 0.12,
      }).addTo(layer);
      L.circleMarker([center.lat, center.lng], { radius: 5, color: COLOUR, fillOpacity: 1 }).addTo(layer);
      map.fitBounds(circle.getBounds(), { padding: [20, 20] });
    }

    if (mode === "polygon" && polygon.length) {
      const shape =
        polygon.length >= 3
          ? L.polygon(polygon, { color: COLOUR, weight: 2, fillOpacity: 0.12 })
          : L.polyline(polygon, { color: COLOUR, weight: 2, dashArray: "4 6" });
      shape.addTo(layer);
      polygon.forEach((point, index) =>
        L.circleMarker(point, {
          radius: index === 0 ? 6 : 4,
          color: COLOUR,
          fillColor: "#fff",
          fillOpacity: 1,
          weight: 2,
        }).addTo(layer)
      );
    }
  }, [mode, center, radiusM, polygon]);

  return <div ref={containerRef} className="search-map" />;
}

export default SearchAreaMap;
