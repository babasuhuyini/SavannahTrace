# Bulk upload (CSV or Excel)

For: officers and IT entering many records at once.

## Where

- **Events** — *My work* → **Bulk upload**, or the "Upload a CSV or Excel file instead" link at the top of any entry form. You only see the event types your role may record.
- **Master data** (IT) — *Master data* → **Bulk upload**, or **Upload** on the Facilities, Collection areas, Processing groups or Collectors tab.

## How

1. Choose what you are uploading and **Download template (CSV)**. Rows starting with `#` are examples and are ignored.
2. Fill it in (Excel is fine). Upload the `.xlsx` directly, or save as **CSV UTF-8**.
3. Review: every row is checked with the same rules as the forms. Rows marked **Error** are not imported; rows marked **Check** are imported with the note.
4. Press **Import**. Download **Rows with errors (CSV)**, fix them, and upload that file again.

Nothing is saved before you press Import. Uploading the same rows twice never creates duplicates (they show as *Already recorded*). Master data is saved in one transaction: all valid rows or none.

## Formats

| What | Accepted |
|---|---|
| Dates | `2026-07-14`, `14/07/2026` (day first), `14 Jul 2026`, Excel dates |
| Times | `08:30`, `8:30 AM`, Excel times |
| Time zone | optional; `+00:00` Ghana by default, `+01:00` / `+02:00` Netherlands |
| Quantities | kilograms with a decimal point (`1250.5`); decimal commas are refused |
| Locations | name or code |
| Identifiers (lot, collector, area, LPO, SFCL) | must match exactly; never changed by the system |

## Event uploads

| Upload | One entry is | Grouped by |
|---|---|---|
| Purchases | one row | — (one purchase per collector per date) |
| Shipments | rows with the same `shipment_ref` | `shipment_ref` |
| Receipts | one shipment | `shipment` (the template lists your open shipments) |
| Issue ODK to groups | rows with the same `issue_ref` | `issue_ref` |
| Processing runs | input + output rows of one run | `run_ref` |
| SFCL aggregations | LPO draws into one new SFCL | `sfcl_number` |
| Ready for pickup | one row (creates a trace link + handoff) | — |
| Deliveries | rows with the same `delivery_ref` | `delivery_ref` |

Purchases: tick *Fill empty Lot ID cells* to use the standard pattern (collector code + MMDDYY) for blank cells only.

## Master data uploads (IT)

Order: **collection areas → collectors**, and **facilities → processing groups**.

- **Collection areas** need an `area_code` column (e.g. `NE06-CA1332`). The coordinates workbook (`COLLECTION AREA, Heading, Latitude, Long, Polygon`) is read as it is once that column is added; *Heading* "Bimbila Collection Area: Achiriyili" becomes operational area *Bimbila*. Polygons are GeoJSON or `lat, lng; lat, lng; …`. Sites without a polygon are listed as errors (17 in the November 2026 workbook). The latitude/longitude columns are used to double-check each polygon.
- **Collectors**: `collector_code`, `name`, optional `area_code`. The collector code must start with its area code.
