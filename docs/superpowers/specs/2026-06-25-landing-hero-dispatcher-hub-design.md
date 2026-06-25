# Landing Hero Dispatcher Hub Design

## Goal

Refresh the landing page hero graphic so it communicates Agent Conveyor as a
transparent control plane for manager-led Codex worker fleets. The image should
make the dispatcher-backed ledger model clear at a glance without feeling like a
generic dashboard, sci-fi command center, or documentation diagram.

## Approved Direction

Use a simple centered Dispatcher Hub graphic:

- A small `Manager` card on the left.
- A central `Dispatcher` card styled as the visual hub.
- Three managed worker lanes/cards on the right.
- A slim `Ledger` strip beneath the flow.
- Clean bi-directional connectors between `Manager` and `Dispatcher`.
- Clean bi-directional connectors between `Dispatcher` and the workers.
- A subtler downward recording line into the `Ledger`.
- No legend or explanatory key at the bottom.

The graphic should read as: the manager and workers communicate through the
dispatcher, and the ledger records durable receipts/state beneath that exchange.

## Visual Style

Keep the image grounded and product-native:

- Restrained SaaS UI illustration, not fantasy or sci-fi.
- White/light-gray surfaces with deep ink text.
- Muted blue connector lines.
- Teal/green status accents.
- A small amber proof accent in the ledger strip.
- Gentle depth, crisp geometry, generous whitespace.

Avoid neon glow, holograms, abstract node webs, decorative blobs, mascots,
robots, complex analytics dashboards, or dense microtext.

## Copy And Labels

Use only the labels needed for instant comprehension:

- `Manager`
- `Dispatcher`
- `Worker A`, `Worker B`, `Worker C`
- `Ledger`
- One small `Receipt` tag inside the ledger strip.

Avoid extra metrics, numbered counters, legends, explanatory paragraphs, and
fake marketing copy inside the image.

## Implementation Notes

For this implementation, keep the graphic code-native in
`docs/landing-page.html`. Use stable responsive dimensions so the hero image
does not clip on mobile. The mobile version may stack the same elements
vertically, but it must preserve the core meaning: manager, dispatcher, workers,
ledger, and bidirectional flow.

## Success Criteria

- The dispatcher is the most prominent element.
- The arrows/connectors clearly show two-way flow.
- The ledger reads as a durable record, not a decorative footer.
- There is no legend.
- The graphic is simpler and calmer than the current implementation.
- Desktop and mobile screenshots show no horizontal overflow or clipped labels.
