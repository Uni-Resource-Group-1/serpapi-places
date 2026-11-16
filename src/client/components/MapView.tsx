import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import type { Bounds, Coordinates, Place, SearchMode } from "../../shared/types.js";
import { formatDistance, sourceLabel } from "../format.js";
import {
  MapPinIcon,
  markerPinSvg,
  markerRankLabel,
  placeIconLabel,
  placeIconName,
} from "./icons.js";

interface MapViewProps {
  /** Already filtered and ordered by App, so marker numbers match list rows. */
  places: Place[];
  rankById: ReadonlyMap<string, number>;
  outsideHiddenCount?: number;
  onShowOutside?: () => void;
  loading?: boolean;
  center: Coordinates | null;
  radiusMeters: number;
  mode: SearchMode;
  bounds: Bounds | null;
  selectedId: string | null;
  hoveredId: string | null;
  onSelect: (id: string) => void;
  onMapClick: (center: Coordinates) => void;
  onViewport: (bounds: Bounds) => void;
  fitToken: number;
  geographyFocus: { center: Coordinates | null; level: "country" | "region" | "county" | "city"; token: number } | null;
  tiles: { url: string; attribution: string; maxZoom: number };
  layers: { osm: boolean; serpapi: boolean };
  onLayersChange: (layers: { osm: boolean; serpapi: boolean }) => void;
  /** Selects the current map viewport as the search area, then returns to search on mobile. */
  onUseMapView: () => void;
}

/**
 * One accessible description for a marker, shared by the rebuild and the
 * selection effect so the two cannot drift apart.
 */
function markerAlt(
  place: Place,
  rank: number | null,
  kind: ReturnType<typeof placeIconName>,
  selected: boolean,
): string {
  return [
    place.name,
    rank === null ? null : `result ${rank}`,
    sourceLabel(place.source),
    placeIconLabel(kind),
    place.category ?? "uncategorised",
    selected ? "selected" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

interface MarkerIconOptions {
  source: Place["source"];
  selected: boolean;
  rank: number | null;
}

/**
 * A Google-Maps-style marker: a source-coloured teardrop with the result number
 * inside its head. The category is deliberately not drawn on the pin, so a dense
 * map stays legible; it remains in the tooltip and aria-label.
 */
function markerIcon({ source, selected, rank }: MarkerIconOptions): L.DivIcon {
  const classes = ["pd-marker", `pd-marker--${source}`];
  if (selected) classes.push("pd-marker--selected");
  return L.divIcon({
    className: classes.join(" "),
    html: `${markerPinSvg(source)}${markerRankLabel(rank)}`,
    iconSize: [26, 38],
    iconAnchor: [13, 36],
    tooltipAnchor: [0, -34],
  });
}

function clusterIcon(source: Place["source"], count: number): L.DivIcon {
  return L.divIcon({
    className: `pd-cluster pd-cluster--${source}`,
    html: `<span aria-hidden="true">${count}</span>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

function centerIcon(): L.DivIcon {
  return L.divIcon({
    className: "pd-center-marker",
    html: '<span aria-hidden="true"></span>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function toBounds(bounds: L.LatLngBounds): Bounds {
  return {
    south: bounds.getSouth(),
    west: bounds.getWest(),
    north: bounds.getNorth(),
    east: bounds.getEast(),
  };
}

export function MapView({
  places,
  rankById,
  outsideHiddenCount = 0,
  onShowOutside,
  loading = false,
  center,
  radiusMeters,
  mode,
  bounds,
  selectedId,
  hoveredId,
  onSelect,
  onMapClick,
  onViewport,
  fitToken,
  geographyFocus,
  tiles,
  layers,
  onLayersChange,
  onUseMapView,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const osmClusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const serpClusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const markerMapRef = useRef(new Map<string, L.Marker>());
  const radiusRef = useRef<L.Circle | null>(null);
  const boundsRef = useRef<L.Rectangle | null>(null);
  const centerMarkerRef = useRef<L.Marker | null>(null);
  const callbacksRef = useRef({ onMapClick, onViewport, onSelect });
  callbacksRef.current = { onMapClick, onViewport, onSelect };
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const geographyLat = geographyFocus?.center?.lat;
  const geographyLon = geographyFocus?.center?.lon;
  const geographyLevel = geographyFocus?.level;
  const geographyToken = geographyFocus?.token;
  const hoveredRef = useRef<string | null>(null);
  hoveredRef.current = hoveredId;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const initialCenter: [number, number] = center ? [center.lat, center.lon] : [23.8103, 90.4125];
    const map = L.map(containerRef.current, {
      zoomControl: false,
      preferCanvas: false,
      center: initialCenter,
      zoom: 14,
      minZoom: 3,
      maxZoom: 19,
      attributionControl: true,
    });
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);
    const tile = L.tileLayer(tiles.url, {
      attribution: tiles.attribution,
      maxZoom: tiles.maxZoom,
      crossOrigin: true,
    }).addTo(map);
    tileRef.current = tile;

    const osmCluster = L.markerClusterGroup({
      showCoverageOnHover: false, maxClusterRadius: 52,
      iconCreateFunction: (cluster) => clusterIcon("osm", cluster.getChildCount()),
    });
    const serpCluster = L.markerClusterGroup({
      showCoverageOnHover: false, maxClusterRadius: 52,
      iconCreateFunction: (cluster) => clusterIcon("serpapi", cluster.getChildCount()),
    });
    osmCluster.addTo(map);
    serpCluster.addTo(map);
    for (const [clusterGroup, source] of [
      [osmCluster, "OpenStreetMap"],
      [serpCluster, "SerpApi"],
    ] as const) {
      clusterGroup.on("animationend spiderfied unspiderfied", () => {
        for (const marker of clusterGroup.getLayers()) {
          const visible = clusterGroup.getVisibleParent(marker as L.Marker);
          if (visible instanceof L.MarkerCluster) {
            visible.getElement()?.setAttribute("aria-label", `${visible.getChildCount()} ${source} places; activate to expand`);
          }
        }
      });
    }
    osmClusterRef.current = osmCluster;
    serpClusterRef.current = serpCluster;

    map.on("click", (event: L.LeafletMouseEvent) => {
      if (modeRef.current !== "radius") return;
      callbacksRef.current.onMapClick({ lat: event.latlng.lat, lon: event.latlng.lng });
    });
    const emit = () => {
      callbacksRef.current.onViewport(toBounds(map.getBounds()));
    };
    map.on("moveend", emit);
    map.on("zoomend", emit);
    emit();
    mapRef.current = map;

    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(containerRef.current);
    window.setTimeout(() => map.invalidateSize(), 60);
    const markerMap = markerMapRef.current;

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      osmClusterRef.current = null;
      serpClusterRef.current = null;
      markerMap.clear();
      radiusRef.current = null;
      boundsRef.current = null;
      centerMarkerRef.current = null;
      tileRef.current = null;
    };
    // Map is created once; later changes are handled by dedicated effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const tile = tileRef.current;
    if (!tile) return;
    tile.setUrl(tiles.url);
    tile.options.attribution = tiles.attribution;
    tile.options.maxZoom = tiles.maxZoom;
  }, [tiles.url, tiles.attribution, tiles.maxZoom]);

  useEffect(() => {
    const map = mapRef.current;
    const osmCluster = osmClusterRef.current;
    const serpCluster = serpClusterRef.current;
    if (!map || !osmCluster || !serpCluster) return;
    if (layers.osm) {
      if (!map.hasLayer(osmCluster)) map.addLayer(osmCluster);
    } else {
      map.removeLayer(osmCluster);
    }
    if (layers.serpapi) {
      if (!map.hasLayer(serpCluster)) map.addLayer(serpCluster);
    } else {
      map.removeLayer(serpCluster);
    }
  }, [layers.osm, layers.serpapi]);

  // Rebuild markers when the result set changes.
  useEffect(() => {
    const osmCluster = osmClusterRef.current;
    const serpCluster = serpClusterRef.current;
    if (!osmCluster || !serpCluster) return;
    osmCluster.clearLayers();
    serpCluster.clearLayers();
    markerMapRef.current.clear();

    places.forEach((place) => {
      if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return;
      const rank = rankById.get(place.id) ?? null;
      const kind = placeIconName(place.category);
      const marker = L.marker([place.lat, place.lon], {
        icon: markerIcon({ source: place.source, selected: place.id === selectedId, rank }),
        keyboard: true,
        title: rank === null ? place.name : `${rank}. ${place.name}`,
        alt: markerAlt(place, rank, kind, false),
        riseOnHover: true,
      });
      const tooltip = document.createElement("div");
      tooltip.className = "pd-tooltip";
      const title = document.createElement("strong");
      title.textContent = rank === null ? place.name : `${rank}. ${place.name}`;
      const meta = document.createElement("span");
      meta.textContent = `${sourceLabel(place.source)} · ${place.category ?? "Uncategorised"} · ${formatDistance(place.distanceMeters)}`;
      tooltip.append(title, meta);
      marker.bindTooltip(tooltip, { direction: "top", offset: [0, -12], opacity: 1 });
      marker.on("click", () => callbacksRef.current.onSelect(place.id));
      marker.on("add", () => {
        const element = marker.getElement();
        if (element) element.setAttribute("aria-label", markerAlt(place, rank, kind, false));
      });
      markerMapRef.current.set(place.id, marker);
      if (place.source === "osm") osmCluster.addLayer(marker);
      else serpCluster.addLayer(marker);
    });
    const labelClusters = (group: L.MarkerClusterGroup, source: string) => {
      for (const marker of group.getLayers()) {
        const visible = group.getVisibleParent(marker as L.Marker);
        if (visible instanceof L.MarkerCluster) {
          visible.getElement()?.setAttribute("aria-label", `${visible.getChildCount()} ${source} places; activate to expand`);
        }
      }
    };
    requestAnimationFrame(() => {
      labelClusters(osmCluster, "OpenStreetMap");
      labelClusters(serpCluster, "SerpApi");
    });
    // Selection is reflected by the dedicated effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, rankById]);

  // Reflect selection without rebuilding every marker.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const byId = new Map(places.map((place) => [place.id, place]));
    for (const [id, item] of markerMapRef.current) {
      const isSelected = id === selectedId;
      item.setZIndexOffset(isSelected ? 1000 : 0);
      const itemPlace = byId.get(id);
      // A marker without loaded place data keeps its glyph and just loses the highlight.
      item.setIcon(
        markerIcon({
          source: itemPlace?.source ?? "osm",
          selected: isSelected,
          rank: rankById.get(id) ?? null,
        }),
      );
      if (itemPlace) {
        item.getElement()?.setAttribute(
          "aria-label",
          markerAlt(itemPlace, rankById.get(id) ?? null, placeIconName(itemPlace.category), isSelected),
        );
      }
    }
    const marker = selectedId ? markerMapRef.current.get(selectedId) : null;
    if (!marker) return;
    marker.openTooltip();
    const latlng = marker.getLatLng();
    if (!map.getBounds().pad(-0.15).contains(latlng)) {
      map.panTo(latlng, { animate: true });
    }
  }, [selectedId, places, rankById]);

  // Reflect hovered card -> marker tooltip (kept separate from rebuilds).
  useEffect(() => {
    const marker = hoveredId ? markerMapRef.current.get(hoveredId) : null;
    if (marker) marker.openTooltip();
    return () => {
      marker?.closeTooltip();
    };
  }, [hoveredId]);

  // Follow explicit geography selections only; map clicks and search-center drags do not zoom.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !geographyToken || geographyLat === undefined || geographyLon === undefined) return;
    const zoom = geographyLevel === "country" ? 5 : geographyLevel === "region" ? 9 : geographyLevel === "county" ? 11 : 13;
    map.setView([geographyLat, geographyLon], zoom, { animate: true });
  }, [geographyLat, geographyLon, geographyLevel, geographyToken]);

  // Radius circle.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (mode === "radius" && center) {
      const latlng: L.LatLngExpression = [center.lat, center.lon];
      if (!radiusRef.current) {
        radiusRef.current = L.circle(latlng, {
          radius: radiusMeters,
          color: "#0e7c66",
          weight: 2,
          fillColor: "#0e7c66",
          fillOpacity: 0.06,
          dashArray: "6 6",
        }).addTo(map);
      } else {
        radiusRef.current.setLatLng(latlng).setRadius(radiusMeters);
      }
    } else if (radiusRef.current) {
      map.removeLayer(radiusRef.current);
      radiusRef.current = null;
    }
  }, [mode, center, radiusMeters]);

  // Center / drag marker.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!center || mode !== "radius") {
      if (centerMarkerRef.current) {
        map.removeLayer(centerMarkerRef.current);
        centerMarkerRef.current = null;
      }
      return;
    }
    const latlng: L.LatLngExpression = [center.lat, center.lon];
    if (!centerMarkerRef.current) {
      centerMarkerRef.current = L.marker(latlng, {
        icon: centerIcon(),
        draggable: true,
        keyboard: true,
        title: "Search center — drag to move",
        alt: "Search center",
        zIndexOffset: 900,
      })
        .addTo(map)
        .on("dragend", () => {
          const position = centerMarkerRef.current?.getLatLng();
          if (position) callbacksRef.current.onMapClick({ lat: position.lat, lon: position.lng });
        });
    } else {
      centerMarkerRef.current.setLatLng(latlng);
    }
  }, [center, mode]);

  // Area rectangle.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (mode === "area" && bounds) {
      const latLngBounds = L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]);
      if (!boundsRef.current) {
        boundsRef.current = L.rectangle(latLngBounds, {
          color: "#b45309",
          weight: 2,
          fillColor: "#f59e0b",
          fillOpacity: 0.07,
          dashArray: "4 6",
        }).addTo(map);
      } else {
        boundsRef.current.setBounds(latLngBounds);
      }
    } else if (boundsRef.current) {
      map.removeLayer(boundsRef.current);
      boundsRef.current = null;
    }
  }, [mode, bounds]);

  // Fit-to-results trigger.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fitToken === 0) return;
    if (places.length > 0) {
      const latLngs = places
        .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lon))
        .map((place) => L.latLng(place.lat, place.lon));
      if (latLngs.length === 1) {
        const single = latLngs[0];
        if (single) map.setView(single, Math.max(map.getZoom(), 16), { animate: true });
      } else if (latLngs.length > 1) {
        map.fitBounds(L.latLngBounds(latLngs), { padding: [48, 48], maxZoom: 16, animate: true });
      }
    } else if (mode === "area" && bounds) {
      map.fitBounds(L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]), {
        padding: [32, 32],
      });
    } else if (center) {
      map.setView([center.lat, center.lon], 14, { animate: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitToken]);

  const fitNow = () => {
    const map = mapRef.current;
    if (!map) return;
    if (places.length > 0) {
      const latLngs = places
        .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lon))
        .map((place) => L.latLng(place.lat, place.lon));
      if (latLngs.length === 1) {
        const single = latLngs[0];
        if (single) map.setView(single, Math.max(map.getZoom(), 16));
      } else if (latLngs.length > 1) {
        map.fitBounds(L.latLngBounds(latLngs), { padding: [48, 48], maxZoom: 16 });
      }
    } else if (center) {
      map.setView([center.lat, center.lon], 14);
    }
  };

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-canvas" role="application" aria-label="Places map" />
      {places.length === 0 ? (
        <div className="map-placeholder" role="status">
          <span className="map-placeholder__icon" aria-hidden="true">
            <MapPinIcon size={26} />
          </span>
          <strong>
            {loading
              ? "Loading places…"
              : outsideHiddenCount > 0
                ? "All loaded places are outside the selected area"
                : "No places to plot yet"}
          </strong>
          <p>
            {loading
              ? "Results will appear on the map as soon as the run finishes."
              : outsideHiddenCount > 0
                ? `${outsideHiddenCount} loaded place${outsideHiddenCount === 1 ? "" : "s"} fall outside the area you selected. They are kept in the run and only hidden from this view.`
                : "Run a search to plot results here, or widen the search area if nothing matches."}
          </p>
          {outsideHiddenCount > 0 && onShowOutside ? (
            <button type="button" className="button button--secondary button--small" onClick={onShowOutside}>
              Show outside selected area
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="map-toolbar" aria-label="Map layers">
        <label className="layer-toggle">
          <input
            type="checkbox"
            checked={layers.osm}
            onChange={(event) => onLayersChange({ ...layers, osm: event.target.checked })}
          />
          <span className="layer-dot layer-dot--osm" aria-hidden="true" />
          OSM <span className="layer-count">{places.filter((place) => place.source === "osm").length}</span>
        </label>
        <label className="layer-toggle">
          <input
            type="checkbox"
            checked={layers.serpapi}
            onChange={(event) => onLayersChange({ ...layers, serpapi: event.target.checked })}
          />
          <span className="layer-dot layer-dot--serpapi" aria-hidden="true" />
          SerpApi <span className="layer-count">{places.filter((place) => place.source === "serpapi").length}</span>
        </label>
        <button type="button" className="map-toolbar__button" onClick={fitNow} aria-label="Fit loaded places on map">
          Fit
        </button>
        {mode === "area" ? (
          <button
            type="button"
            className="map-toolbar__button map-toolbar__button--primary"
            onClick={onUseMapView}
            aria-label="Use current map view as the search area"
          >
            Use this view
          </button>
        ) : null}
      </div>
      {mode === "area" ? (
        <p className="map-hint">Map-area mode: pan or zoom, then use “Use this view” here or in the sidebar.</p>
      ) : null}
      <div className="map-legend">
        <span className="layer-dot layer-dot--osm" aria-hidden="true" /> OSM
        <span className="layer-dot layer-dot--serpapi" aria-hidden="true" /> SerpApi
        <span className="map-legend__note">SerpApi results are ranked samples, not complete inventories.</span>
      </div>
    </div>
  );
}
