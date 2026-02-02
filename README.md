# Ticket Rescue

**Never see “Sold Out” again**

Ticket Rescue is a browser extension that helps users:
- find tickets when an event looks sold out,
- compare ticket prices across sellers,
- discover alternative places where tickets are still available.

The project is developed **in public** and is currently in early active development.

---

## What this project is

Ticket Rescue is:
- a **Chrome browser extension** (Manifest V3),
- backed by a **server-side API** with structured event data,
- focused on **availability first**, with price comparison as a secondary benefit.

The extension does **not** scrape Ticketmaster or modify websites.  
All actions happen only when the user clicks the extension icon.

---

## Core idea

“Sold Out” on one site does not mean tickets are gone.

Ticket Rescue detects the event a user is viewing and shows:
- where tickets are still available,
- base prices (excluding fees & taxes),
- promo-based estimated prices when applicable.

---

## Project documentation

- 📄 **Project Specification:**  
  `docs/Ticket_Rescue_Project_Spec_v0.1.md`

---

## Disclosure

Ticket Rescue aggregates ticket offers from multiple sellers.

One of the supported platforms, Geturtix, is operated by the creators of Ticket Rescue.
Other listed platforms may be affiliate partners.

All offers are shown transparently, and users always choose where to purchase tickets.