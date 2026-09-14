# REVEX × Archiproducts — parked sourcing integration research

Status: **PARKED / RESEARCH ONLY**  
Branch: `research/revex-archiproducts-sourcing`  
Date: 2026-09-14

## Intent

Evaluate Archiproducts as a high-precision product/BIM sourcing provider for REVEX while keeping compliance and certification verification independently owned by REVEX.

Core separation:

> **Archiproducts helps answer: “What exact real product is this?”**  
> **REVEX answers: “Can we responsibly specify this exact product here, and what evidence proves it?”**

This branch intentionally contains no production integration, deployment, scraper, API key, or account automation.

## Why it is interesting

Archiproducts exposes a large structured architecture/design catalog with manufacturer product records, BIM/CAD assets, technical sheets, variants, documentation, and product discovery workflows. It also maintains a Revit-oriented BIM workflow and commercial catalog-synchronization products.

That makes it potentially useful as a provider for:

- manufacturer + exact product/model identity;
- dimensional/material/variant metadata;
- RFA / IFC / DWG / other BIM/CAD asset discovery;
- technical sheets, catalogs, DoP/EPD/certification metadata where available;
- BIM-object provenance and revision tracking;
- supplier / reseller / procurement discovery where commercially permitted.

## Legal / integration boundary

Do **not** build this as an automated website scraper.

Archiproducts' published terms restrict unauthorized automated copying/reuse. The preferred path is a licensed API, feed, catalog partnership, or another explicitly authorized machine-to-machine interface from Archiproducts / Edilportale.

No public developer REST API was identified during the initial research. Their existing Digital Showroom/catalog synchronization products indicate that structured commercial integration capabilities exist, but access and permitted uses need to be confirmed directly with them.

## Proposed provider architecture

```text
REVEX SOURCING
│
├── Design/spec requirement
│
├── Product providers
│     ├── Archiproducts
│     ├── manufacturer-direct sources
│     ├── testing/certification/regulatory sources
│     └── local distributor/availability sources
│
├── Candidate product identity
│     ├── manufacturer
│     ├── product / model / variant
│     ├── dimensions + material
│     ├── BIM/CAD assets
│     ├── technical documents
│     ├── EPD / DoP / certificates
│     ├── supplier / reseller
│     └── source provenance + retrieval/revision time
│
└── REVEX verification
      ├── geometric fit
      ├── specification fit
      ├── jurisdiction/code applicability
      ├── evidence freshness
      ├── availability/logistics
      └── confidence / unresolved evidence
```

## Certification rule

Archiproducts/BIM.archiproducts badges must **not** be interpreted as NYC-code approval or general product-code compliance.

Keep separate evidence layers:

1. **Digital-object quality / BIM provenance**
   - BIM.archiproducts Certified
   - Produced by BIM.archiproducts

2. **Manufacturer product identity**

3. **Manufacturer technical documentation**

4. **Independent product evidence**
   - EPD / DoP where relevant
   - ASTM / ANSI / UL / ETL / ICC-ES / NSF / other applicable testing or listings

5. **REVEX jurisdiction-specific applicability check**
   - APPROVED
   - CONDITIONAL
   - UNVERIFIED

REVEX remains responsible for the final evidence chain and must never convert a BIM-quality badge into a regulatory-compliance assertion.

## Revit / REVEX provenance envelope

Potential internal fields for imported or recognized product objects:

```text
REVEX_SourceProvider       = "Archiproducts"
REVEX_ProductID            = <licensed stable product/variant id>
REVEX_ProductURL           = <source record>
REVEX_Manufacturer         = <manufacturer>
REVEX_Model                = <model / variant>
REVEX_BIMStatus            = Certified / Produced / Unverified
REVEX_SourceRetrievedUTC   = <timestamp>
REVEX_DocumentRevision     = <revision/version when available>
REVEX_DocumentSHA256       = <evidence digest>
REVEX_ComplianceStatus     = Approved / Conditional / Unverified
REVEX_ComplianceBasis      = <REVEX evidence record>
```

### Update behavior

Never silently replace an in-model family when a catalog/BIM object changes.

A future provider should diff old/new evidence and expose the effect before replacement, e.g.:

```text
Product update available
- Height: 420 → 430 mm
- Fire-classification document updated
- Manufacturer catalog revision changed
- 3 project instances affected

Review update
```

## Suggested implementation stages

### Stage 1 — no private provider API required

- Recognize/store Archiproducts product URLs supplied by the user.
- Import user-downloaded RFA/IFC/CAD assets through normal REVEX workflows.
- Extract exact product/model parameters and attach provenance.
- Attach manufacturer documents supplied or lawfully accessible to the user.
- Run REVEX's own evidence/compliance verification independently.

### Stage 2 — licensed provider integration

Approach Archiproducts / Edilportale as LIBER Creative / REVEX and request authorized access to the subset needed for professional BIM/specification workflows:

- catalog/product search;
- stable product + variant IDs;
- manufacturer metadata;
- BIM/CAD asset metadata and authorized download mechanism;
- BIM.archiproducts Certified / Produced status;
- technical-sheet / EPD / DoP / certification metadata;
- document and product revision/update timestamps;
- retailer / availability / Trade Program interfaces where permitted;
- caching, attribution, redistribution and derivative-data rights.

## Long-term opportunity

The useful end-state is not merely “search products.” It is:

```text
requirement
→ exact verified product identity
→ BIM object
→ technical/compliance evidence
→ quantity
→ quote / sample
→ approved specification
→ procurement
```

Provider discovery, regulatory verification, BIM identity, commercial availability and procurement should remain distinct stages with explicit provenance.

## Initial research references

- Archiproducts BIM: https://bim.archiproducts.com/en
- Archiproducts Revit plug-in: https://www.archiproducts.com/en/revit-plug-in
- Archiproducts Terms and Conditions: https://www.archiproducts.com/en/terms-and-conditions
- Archiproducts Business / Digital Showroom: https://business.archiproducts.com/en/retailers/
- Archiproducts Trade Program: https://business.archiproducts.com/en/trade-program/

## Re-entry condition

Resume this branch only when one of these becomes true:

- REVEX sourcing/product-library architecture is being implemented;
- Archiproducts provides an authorized API/feed/partner route;
- a concrete project needs exact product sourcing/provenance integration;
- REVEX compliance evidence architecture is ready to accept external provider records without conflating provider claims with code approval.
