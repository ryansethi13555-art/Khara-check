# Roadmap

Khara Check is maintained by Khara Index. This page says what works, what we decided and why, and what comes next. Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Works today (version 0.1)

* `run`, `verify` and `report`, end to end.
* Planted values and a matcher that finds them readable, encoded (URL encoding at any depth, base64 at any alignment, base64url, gzip, deflate, brotli, LZ-string, JWT, multipart, schema-less protobuf) and hashed (SHA-256 as hex, base64 and base64url, SHA-1, MD5), with normalised email and phone forms (`+91`, `91`, `0`, `0091`).
* Recording through the Chrome DevTools Protocol for every page and cross-site frame: wire headers, `sendBeacon` and keepalive bodies, WebSocket frames, initiator stacks.
* A sandbox that answers every third-party request locally, for development and demos.
* 15 vendor decoders (Google Analytics 4, Google Ads, Google Tag Manager, Meta Pixel, Reddit Pixel, CleverTap, MoEngage, WebEngage, Netcore, Microsoft Clarity, Hotjar, Branch, AppsFlyer, Criteo, Taboola) and 40 more companies recognised by domain.
* Sealed evidence folders: a hash-chained request log, a manifest and one seal; `verify` re-runs the analysis and reproduces both reports byte for byte.
* Three ways to test sites that block automation, none of which disguise it: handoff to a person at a bot check, listen-only `attach`, and `import` of a HAR file.
* Consent testing (banner ignored, "Reject all", "Accept all"), repeat counts, and a scorecard across many sites.

## Decisions

* **Local practice sites always run sandboxed.** Practice data can never reach a real tracker.
* **No invented phone numbers on live sites.** A random ten-digit number may belong to a real person, so live journeys supply their own test number.
* **No disguised automation.** No fingerprint changes, stealth plugins or CAPTCHA solving. It is fragile, it is ethically grey, and it weakens the evidence ("your robot caused it"). Sites that block automation are tested by a person instead.
* **No control run.** Each planted value is unique to its run, so it cannot appear in a request unless the page took it from what was typed.
* **`report` checks integrity before it re-seals.** Otherwise it could be used to launder edited evidence.

## Next

1. **Android apps.** Read mitmproxy flow files as a capture source, with decoders for app SDK traffic (Firebase and GA4 for apps, AppsFlyer, CleverTap, MoEngage, Branch, Adjust, Facebook app events). Apps that pin certificates are reported as "could not inspect", not bypassed.
2. **Trusted timestamps.** An optional RFC 3161 timestamp of the seal from a free public authority, so the date of a capture can be proven without publishing the evidence.
3. **Redaction.** `khara-check redact` removes the tester's own identifiers from a folder before it is shared, while keeping the proof checkable.
4. **More decoders.** Microsoft UET, TikTok, LinkedIn and Snap field meanings.
5. **Product pages as well as searches.** Many sites send the address and title of the page a customer opens. A way to plant a unique page, or to watch named pages, would extend the proof beyond what is typed.
