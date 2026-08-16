# Worker identity normalization contract

`revex_energy_identity_normalizer.py` is the reusable normalization primitive for verified active-Revit identity evidence.

It may consume:
- verified active-document Project Information/titleblock fields;
- immutable Revit sheet PDF text associated with the same Engineering revision;
- explicit city/state/ZIP already present in those sources.

It may not consume:
- reference/template project identity;
- browser project labels as identity authority;
- consultant/engineer/owner/vendor addresses;
- project-specific mappings.

The r69 pre-pipeline resolver may use the US Census geocoder only as a last-resort derivation from an already-authoritative project street, and must preserve source evidence byte-for-byte.

A failed published Engineering revision may be replayed server-side by project/revision after a server repair. Replay is not a Revit sync and must never trigger Revit export or model mutation.
