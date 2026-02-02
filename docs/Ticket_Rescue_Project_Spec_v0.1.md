# Ticket Rescue (working name) — Project Spec v0.1

**Tagline:** Never see “Sold Out” again.

---

## 0. Purpose

**Business goal:**  
Drive ticket purchases via four sources (Geturtix + three partners). Even if the purchase happens on partner sites, revenue is acceptable; Geturtix is preferred when promo codes exist.

**Core user value:**  
When an event page shows limited or no availability (or any event page in general), the extension finds the same event in our structured database and shows alternative places to buy tickets — often where tickets are still available — with transparent pricing and promo information.

---

## 1. Product Definition

### 1.1 Primary Use Case
1. User is on an event page (Ticketmaster or any other site).
2. User clicks the extension icon.
3. Extension extracts key signals (performer, date, city/state, venue when possible).
4. Extension calls the backend API.
5. Backend returns one or more matching events and available offers.
6. Popup displays sorted offers; user manually clicks a link.

### 1.2 Secondary / Fallback Use Cases
- If exact event matching is not confident:
  - Show all upcoming concerts for the performer.
  - Show upcoming concerts for the performer in a specific city/state.

### 1.3 Explicit Non-Goals
- No scraping Ticketmaster prices or inventory.
- No link replacement or silent affiliate injection.
- No automatic redirects.
- No background activity without explicit user click.

---

## 2. Data Sources

### 2.1 Offer Sources
- **Geturtix** (own platform)
- **TN** (partner)
- **TL** (partner)
- **SBS** (partner)

Internal identifiers:
- `geturtix`, `tn`, `tl`, `sbs`

UI displays full platform names (no abbreviations).

### 2.2 Feeds
- Each source provides a daily CSV feed.
- All CSV files are identical in schema and row count.
- `EventID` is stable and does not change.
- An event remains in the feed until it has occurred.

---

## 3. Data Model (Conceptual)

### 3.1 Canonical Event
Represents the event itself.

- `event_id` (canonical, derived from EventID)
- `event_name`
- `date_day` (YYYY-MM-DD)
- `datetime` (stored, but matching primarily uses date_day)
- `city`, `state`, `country`
- `venue`
- `performer_display` (raw performer string)
- `performer_norm`
- `venue_norm`, `city_norm`
- `created_at`, `updated_at`

### 3.2 Offer
Each event has up to four offers (one per source).

- `source` (geturtix / tn / tl / sbs)
- `event_id` (FK)
- `url`
- `price_min`, `price_max`
- `price_range_raw`
- `currency` (default USD unless specified)
- `tickets_yn`
- `promo_percent` (nullable; initial state = null)
- `last_seen_at`

### 3.3 Performer Structure (Future-Proofing)
Feeds may contain performer variants (tours, shows, tribute acts).

Potential future tables:
- `performers`
- `event_performers`
- `canonical_performers`
- `performer_aliases`

For v0.1, matching relies on normalized performer strings with guard rules.

---

## 4. Matching Logic (v0.1)

### 4.1 Input Signals from Page
- `performer_query` (string)
- `city` (optional)
- `state` (optional)
- `date_day` (optional)
- `venue` (optional)

### 4.2 Matching Order
- If `date_day` exists:
  1. Filter by `date_day`.
  2. Filter by `city/state` when available.
  3. Match performer.

- If no date:
  - Performer-first matching.
  - Prefer fallback result pages rather than a specific event.

### 4.3 Performer Matching Rules
- Normalize all strings (lowercase, remove punctuation/diacritics, collapse whitespace).
- Token-based matching with stopword removal (`tour`, `show`, `experience`, `festival`, `live`).
- Do **not** canonicalize when strong disqualifiers exist:
  - `tribute`, `salute`, `orchestra`, `symphony`, `performed by`, `plays`.
- If multiple events match equally, return all.

### 4.4 Multiple Events
If multiple candidate events exist for the same performer + city + day, return all of them.

---

## 5. Pricing Display Rules

### 5.1 Base Prices
- All prices from feeds are **base prices**.
- Must be labeled clearly:
  - **Base price (excl. fees & taxes)**

### 5.2 Promo Pricing
- Promo codes may be null or percentage-based.
- Estimated display value:
  - `estimated_after_promo = price_min × (1 − promo_percent)`
- Label:
  - **Est. after promo (excl. fees & taxes)**

### 5.3 Sorting
- Sort offers by estimated_after_promo when promo exists.
- Otherwise, sort by base price_min.

---

## 6. Extension Behavior

### 6.1 Permissions
- Minimal permissions only:
  - `activeTab`, `scripting`, `storage`.

### 6.2 Architecture (Chrome MV3)
- **Content Script** — extracts page signals.
- **Background Service Worker** — calls backend API.
- **Popup UI** — renders offers and actions.

### 6.3 Data Extraction Priority
1. JSON-LD `Event` / `MusicEvent`.
2. `h1` tag.
3. `document.title`.

Extraction and backend calls occur **only on user click**.

### 6.4 UX Messaging
Primary:
- “Looks sold out here — but tickets may still be available elsewhere.”

Fallback:
- “We couldn’t match an exact event. See all upcoming shows for [Performer].”

---

## 7. Backend Services

### 7.1 API Endpoints (v0.1)

- `POST /match`
  - Input: performer, city, state, date_day, venue (optional)
  - Output: confidence level + matching events + offers

- `POST /ingest`
  - Input: source identifier + CSV file
  - Output: counts of new, updated, and seen records

### 7.2 Update Modes
- Initial full import
- Incremental updates by EventID:
  - Insert new EventIDs
  - Update offer fields (price, tickets_yn)
  - Refresh last_seen timestamps

---

## 8. Landing Page (v0.1)

**Goal:** Convert UGC traffic into installs.

Elements:
- Hero headline: **Never see “Sold Out” again**
- One short GIF/video demonstrating sold-out → alternatives
- Trust bullets:
  - No website modifications
  - Manual user clicks only
  - Transparent pricing (excl. fees & taxes)

CTA:
- Add to Chrome

---

## 9. Chrome Web Store Checklist

- Clear, neutral description (no competitor hostility)
- Privacy policy
- Minimal permissions justification
- Screenshots with disclaimers

---

## 10. Build-in-Public (Twitter)

Language: English.

Daily devlog format:
- Today I built:
- Biggest issue:
- Next:

Content themes:
- Sold Out ≠ No Tickets
- Transparent pricing reality
- MV3 architecture insights

---

## 11. Milestones (1-Week Target)

- M1: Backend imports 1 CSV and matches events correctly
- M2: Support all 4 sources as offers
- M3: End-to-end extension MVP
- M4: UX + pricing labels
- M5: Landing page
- M6: Chrome Web Store submission

---

## 12. Open Questions

1. Final product name: **Ticket Rescue** vs **NeverSoldOut**.
2. Promo code rotation rules once partner codes arrive.
3. Public vs private repository split (client open-source, backend private).
