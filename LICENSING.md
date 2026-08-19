# Licensing & Attribution — NVIS MVG map (DCCEEW / BDR)

**Purpose:** record the copyright, licence, and required attribution for the NVIS
Major Vegetation Groups (MVG) vector map published to Mapbox and hosted by the
Biodiversity Data Repository (BDR), DCCEEW.

**Status:** verified against DCCEEW's copyright notice and the NVIS data product
pages (see Sources). Last checked: 2026-07-23.

---

## 1. Summary (the short version)

- **Licence:** Creative Commons **Attribution 4.0 International (CC BY 4.0)** —
  DCCEEW's default licence for its material.
- **Copyright holder:** © Department of Climate Change, Energy, the Environment
  and Water (DCCEEW), Australian Government.
- **Attribution required:** YES. CC BY 4.0 always requires attribution, even for
  internal/first-party DCCEEW/BDR publishing.
- **Third-party acknowledgement required:** YES. NVIS is compiled from data
  supplied by state/territory agencies; those custodians must be acknowledged.
- **Excluded from CC BY (do NOT imply these are CC BY):** the Commonwealth Coat of
  Arms, the DCCEEW logo, and any content marked as third-party copyright.

Because DCCEEW owns NVIS and BDR is part of DCCEEW, this is first-party reuse —
there is no licensing barrier to publishing. Attribution is still best practice
and a CC BY condition.

---

## 2. Attribution text to display on the map

Put a visible credit on/near the map (e.g. in the Mapbox attribution control or a
footer). Use one of the following.

**Primary dataset credit (concise, for the map attribution control):**

> © Department of Climate Change, Energy, the Environment and Water (DCCEEW).
> National Vegetation Information System (NVIS) Version 7.0. Licensed under
> CC BY 4.0. Includes data © State and Territory Governments of Australia.

**Formal citation (for an About page / metadata):**

> Department of Climate Change, Energy, the Environment and Water (DCCEEW) 2025.
> *National Vegetation Information System (NVIS) Version 7.0 — Major Vegetation
> Groups (Extant).* Australian Government, Canberra. Licensed under Creative
> Commons Attribution 4.0 International (CC BY 4.0).
> https://www.dcceew.gov.au/environment/environment-information-australia/national-vegetation-information-system

DCCEEW's copyright notice specifies the attribution pattern:
> "Department of Climate Change, Energy, the Environment and Water. [year].
> [name of publication and website link]."

---

## 3. Third-party (state/territory) acknowledgement

NVIS is "derived from a compilation of data collected at different scales on
different dates by different organisations." The authoritative NVIS MVG service
lists these custodians. Acknowledge them (an About/credits page is sufficient;
they need not all fit in the map's corner attribution):

> This product incorporates data provided by the Australian State and Territory
> Government agencies:
> - Environment, Planning and Sustainable Development Directorate, ACT
> - Office of Environment and Heritage / DCCEEW, NSW
> - Department of Environment, Parks and Water Security, NT
> - Queensland Herbarium, Department of Environment and Science, QLD
> - Department for Environment and Water, SA
> - Department of Natural Resources and Environment (NRE), TAS
> - Department of Energy, Environment and Climate Action, VIC
> - Department of Primary Industries and Regional Development (DPIRD), WA
> - Department of Biodiversity, Conservation and Attractions, WA
> together with the Australian Bureau of Agricultural and Resource Economics and
> Sciences (ABARES) and Geoscience Australia.

(Source: `copyrightText` of the NVIS_ext_mvg MapServer service.)

---

## 4. Basemap attribution (Mapbox / OpenStreetMap)

The map is rendered with Mapbox GL JS on a Mapbox base style. Mapbox's own
attribution requirements are SEPARATE from the NVIS data licence and must ALSO be
shown (they appear automatically via the default `AttributionControl` — do not
remove it):

> © Mapbox  © OpenStreetMap   (and "Improve this map" as Mapbox provides)

So the final on-map credits combine three things:
1. **NVIS/DCCEEW** data attribution (section 2) — you must add this.
2. **State/Territory** acknowledgement (section 3) — About page.
3. **Mapbox © / OpenStreetMap ©** — automatic; keep the attribution control on.

---

## 5. How to implement in the client (Mapbox GL JS)

Keep the default attribution control (already enabled in `MapView.vue` /
`NvisVectorMap.vue` via `attributionControl: true`) and attach the NVIS credit to
the vector source so it shows whenever the layer is visible:

```js
map.addSource('nvis-mvg-vec', {
  type: 'vector',
  url: 'mapbox://USERNAME.nvis_mvg_vector',
  attribution:
    '© DCCEEW — NVIS v7.0 (CC BY 4.0); incl. data © Australian State/Territory Governments'
})
```

Mapbox merges this string into the attribution control alongside the automatic
© Mapbox / © OpenStreetMap credits. Put the fuller custodian list and formal
citation (sections 2–3) on an About/Credits page.

---

## 6. Do / Don't checklist

- ✅ Show the DCCEEW/NVIS CC BY 4.0 credit on the map.
- ✅ Acknowledge the state/territory custodians (About page).
- ✅ Keep the Mapbox/OSM attribution control visible.
- ✅ State the licence as "CC BY 4.0" with a link to the licence deed
  (https://creativecommons.org/licenses/by/4.0/).
- ✅ Note the dataset version (NVIS v7.0) and theme (Extant MVG).
- ❌ Don't apply CC BY to the Commonwealth Coat of Arms or the DCCEEW logo.
- ❌ Don't remove or hide the Mapbox/OSM attribution.
- ❌ Don't imply endorsement by the state/territory custodians.

---

## 7. Sources (verified)

- DCCEEW Copyright notice (CC BY 4.0 default + attribution pattern):
  https://www.dcceew.gov.au/about/copyright
- NVIS data products (downloads, versions, custodial note):
  https://www.dcceew.gov.au/environment/environment-information-australia/national-vegetation-information-system/data-products
- NVIS MVG Extant service (custodian list in `copyrightText`):
  https://gis.environment.gov.au/gispubmap/rest/services/ogc_services/NVIS_ext_mvg/MapServer
- CC BY 4.0 legal deed:
  https://creativecommons.org/licenses/by/4.0/

> Note: This is practical guidance, not legal advice. For a public-facing BDR
> release, have DCCEEW's data-governance/legal team confirm the exact on-page
> wording and any dataset-specific metadata record (some FED records carry their
> own licence statement that should be quoted verbatim).
