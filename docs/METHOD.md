# The Khara Check method

This is the standard of evidence Khara Check is built to meet. It is written for journalists, researchers, regulators and the companies whose sites are tested, so that each of them can judge a finding on the same terms.

## 1. The question

A customer types something into a website: a medicine name, an email address, a phone number. **Did the page send it to another company?**

Khara Check answers that question for one run of one journey. It does not answer "does this site always do this", "what did the other company do with it", or "is this illegal". Those need more than a capture.

## 2. Planted values ("canaries")

Every run types values that exist nowhere else in the world:

| Kind | Example | Why it is safe to search for |
| --- | --- | --- |
| Search term | `metformin 500 kqzvtbn` | A realistic term plus a seven-letter consonant marker drawn from a cryptographic random source. No real page contains it. |
| Email | `khara.kqzvtbn@example.com` | `example.com` is reserved by the IETF and never delivers mail. |
| Phone | supplied by the tester | Khara Check refuses to invent phone numbers for live sites, because a random number may belong to a real person. In sandbox runs it generates one. |

Because each value is unique to the run, finding it in a request is not a coincidence. A value without a unique marker (for example a supplied phone number) is labelled "common" in the findings.

## 3. Disguises the matcher sees through

Trackers rarely send a value as it was typed. For each canary Khara Check prepares the forms it may take, then peels every request apart layer by layer and looks for those forms at every layer.

* **Readable forms**: as typed, trimmed, lower-cased, spaces collapsed or removed, words joined by `-`, `_`, `+` or `%20`. Phone numbers with and without `+91`, `91`, `0` or `0091`, and grouped 5-5 or 3-3-4.
* **Layers peeled**: URL parameters, percent-encoding at any depth, form bodies, multi-line batch bodies (GA4), JSON at any depth, base64 and base64url, gzip, zlib, raw deflate and brotli, LZ-string (used by CleverTap), payloads encrypted with a key that is sent in the same request (CleverTap's optional "encryption in transit", AES-GCM with fields `itp`, `itk` and `itv`), JSON Web Tokens, multipart form parts, binary protobuf without a schema (raw hash bytes become hex), `;`-separated parameter lists (Google Ads, Floodlight). Decoded text must contain no control characters, so binary is never mistaken for text.
* **Base64 at any alignment**: a value buried inside a larger base64 blob is found even if it does not start on a 3-byte boundary.
* **Hashes**: SHA-256 (hex, base64 and base64url), SHA-1 and MD5 of every normalised form. This is how Meta "advanced matching" and Google "enhanced conversions" send emails and phone numbers.

Every hit records the **decode path**: the exact sequence of layers from the raw request to the value, for example `JSON field "d" → base64-decoded → JSON field "evtData.Term"`. A reader can follow it by hand.

## 4. What counts as a finding

A finding needs all of these:

1. **A recorded request.** Every finding names the request (`r0023`) in the hash-chained capture log. A finding without a request is a bug.
2. **A third-party recipient.** The recipient's registrable domain (eTLD+1, from the Public Suffix List) differs from the site's and from any domain the journey declares as the site's own. Requests to the site itself are listed separately, as expected behaviour. One exception: when a hostname that looks like the site's own is a DNS alias (CNAME) for a recognised analytics, advertising or marketing service, it is counted as that service. Live runs look up these aliases when the capture is made and store them in `run.json`, so the analysis stays a pure function of the folder. Aliases for hosting and CDN companies are ignored.
3. **The planted value inside it**, in one of the forms above. A match on the unique marker alone is reported as "in part", never as a full match.

Two further tiers are reported separately and never mixed into the headline count:

* **Collectors at the site's own address.** A request to the site itself that has the shape of a known data collection service (RudderStack, Segment, Snowplow, or the Google Analytics protocol used by server-side tagging) is flagged. The browser cannot see where such a collector sends the data next, so the report says so instead of calling it either a leak or expected.
* **Names like the site's own.** An unrecognised recipient whose registrable domain begins with the same five or more letters as the site's (`apollo247.in` for `apollopharmacy.in`) may belong to the same owner. It is shown but not counted in the headline, and the report says to declare it under `site.firstParty` if it does.
* **Referer only.** A company that received a value only in the `Referer` header, because the browser passed on the full page address while loading one of its files, is listed in its own tier. The disclosure is real, and it is caused by the site's referrer policy, but it is a different act from a tracker putting the value into an event.

### Google server-side tagging

With Google's server-side tagging (SST), the page sends its Google Analytics hits to a server the site runs, usually at one of its own subdomains, and that server passes the data on to Google and to other companies. The browser only sees the first step, so a list of "outside companies contacted" misses everyone after it.

Khara Check detects SST with the method of Zahra Moti, Kimberley Frings, Christine Utz, Frederik Zuiderveen Borgesius and Gunes Acar in [“The Bitter Pill: Tracking and Remarketing on EU Pharmacy Websites”](https://gunesacar.net/papers/bitter-pill-pharmacy-privacy-dpm-25.pdf) (section 3.4). Their observation: when the endpoint moves, the URL parameters the Google tag sends stay the same. So:

1. **Parameters.** A request to a host that is not Google's is flagged when it carries `v=2`, a GA4 measurement ID (`tid=G-…`) and at least 12 of 30 parameters the Google tag sends on every page hit (`gtm`, `_p`, `gcd`, `cid`, `ul`, `sr`, `sid`, `sct`, `dl`, `dt`, `tfd`, the `ua…` browser hints and others; the list is in `src/findings/sst.ts`). Parameters in a batched body count too. The path does not matter: the paper found endpoints at `/g/collect` and at random paths such as `/ngtwyxyzwjg`. The paper did not publish its own list of 36 parameters, so ours was built the same way, from the parameters present on at least 80% of 109 GA4 hits Khara Check recorded on Indian pharmacy and lab sites.
2. **Initiator.** SST runs on Google Tag Manager, so the paper confirms each endpoint with the script that started the request. Khara Check records the call stack of every request and notes when it contains a Tag Manager or Google tag script, and whether that script was served from Google or from the site itself (a self-hosted Tag Manager).
3. **Hosting.** The paper checked who owns the server's IP address with WHOIS. Khara Check keeps the analysis offline, so it records what the capture shows instead: a `Server: Google Frontend` or `Via: … google` response header, a DNS alias to Google Cloud Run, App Engine, `ghs.googlehosted.com` or the SST host Stape, and the server's IP address, which a reader can look up with `whois`. Hosting on Google Cloud alone proves nothing, since many sites host everything there; it only confirms an endpoint the parameters already found.

**Google tag gateway.** Google also offers a "first-party mode" in which the site's network provider (for example Cloudflare) forwards a path on the site's own domain to Google: the tag is served from `/x7qa/…` and its hits go to `/x7qa/ag/g/c`. No server of the site's own is involved, but the browser again never contacts Google. Khara Check reports it as server-side tagging, labelled as a tag gateway, and confirms it when the tag script was served from the same path prefix, since the gateway gives the script an obfuscated name the Tag Manager pattern cannot recognise.

An endpoint is **confirmed** when the parameters match and the initiator or the hosting agrees, and **likely** when only the parameters match. SST endpoints are listed in their own section of the report, whether or not a planted value reached them. Requests straight to Google (`google-analytics.com`, `analytics.google.com`, `stats.g.doubleclick.net`, `google.*`) are ordinary client-side tagging and are not flagged. Like the paper's method, this finds only Google's SST, not server-side tracking in general, and a site that renames the parameters would not be found.

**Common values.** A value without a unique marker (for example a plain search for "HIV" in an imported recording) is matched only as a whole word, with hyphens and underscores counted as part of a word, so that it cannot match inside a random token or a page name such as `/tests/hiv-1-2-antibody-test`, and only in forms that keep its words apart, so that "pregnancy test kit" does not match a product image named `pregnancy_test_kit.jpg`. Findings based on it are labelled "common". A common value can still match the same word in a page title or product name; only a unique marker separates what was typed from what the page showed. Search values as short as three characters are accepted on these terms; emails and phone numbers need six.

**Runs that stop.** If a step fails or a bot check is not cleared, the report's headline says the run stopped and that it does not show what the site does after that point. A blocked run never reads as a clean result.

Each finding also records the time after the customer's action, the script that started the request (from the browser's own call stack), whether the request was delivered, and what the vendor decoder knows about the call ("Meta Pixel, event Search").

## 5. Capture

Khara Check drives Chromium through Playwright and records network traffic through the Chrome DevTools Protocol, the browser's own instrumentation. That gives the headers actually sent on the wire, bodies of `sendBeacon` and `fetch(…, {keepalive})` calls, WebSocket frames, redirects, and the initiating script. Cross-site iframes get their own recording session. Playwright's independent request events are reconciled against the DevTools log, and anything seen only there is added and labelled, so nothing is dropped silently.

Khara Check does not disguise automation. It does not alter the browser fingerprint, does not use "stealth" patches and does not solve CAPTCHAs. Sites that block automated browsers are tested in one of three ways, each recorded in the evidence:

* **Listen-only (`khara-check attach`).** A person browses in their own Chrome. Khara Check connects over the DevTools Protocol with a minimal client and enables only the Network domain on each tab, frame and worker. It runs no code in the page. Each step is marked by the person; navigations and screenshots are recorded automatically.
* **Handoff.** In a watched automated run, Khara Check recognises common bot checks (Cloudflare, reCAPTCHA, hCaptcha, DataDome, Arkose) and pauses for a person, keeping before and after screenshots. An unwatched run stops instead.

* **Imported HAR file (`khara-check import`).** A person records the journey with their browser's developer tools open and saves the network log as a HAR file, the format every major browser exports. Khara Check converts each entry into the same request record an automated run produces, keeps the original file unchanged inside the sealed folder (`capture/original.har`), and runs the same analysis. Two things are weaker than a watched run, and the report says both: the seal proves the evidence has not changed since it was imported, not since it was recorded; and the planted values are the ones the person says they typed. Values typed without a unique marker are labelled "common".

### Consent and repetition

When a journey names the consent banner's buttons, `--consent all` runs it three times: banner ignored, "Reject all", "Accept all". Each finding carries the consent state at the moment its request left the browser (`before-choice`, `after-reject`, `after-accept`), worked out from the recorded step times, so it is part of the reproducible analysis. `--repeat N` runs each condition N times and the comparison reports "seen in k of N runs". Every folder is verified before it is counted.

### Sandbox mode

Development and demonstrations run in a sandbox: the site is served from the local machine, and every third-party request is recorded in full and then answered locally. As a second wall, the browser is started with every hostname except localhost resolving to nothing. Sandbox findings are labelled "sandboxed": they show where a page *tried* to send data.

## 6. The evidence bundle

Every run writes a folder:

```
journey.yaml              the exact script that was run
run.json                  tool version, browser version, viewport, locale, time zone, the step timeline
canaries.json             the planted values
capture/requests.jsonl    every request, one per line; each line contains the SHA-256 of the line before
capture/cookies.json      cookies at the end of the run
screenshots/, snapshots/  what the page looked like
manifest.json             SHA-256 of every evidence file, chained into a single seal
SEAL.txt                  the seal, for publishing
findings.json, report.html, report.md   derived from the evidence
```

**The seal.** `seal = H(… H(H(genesis ‖ path₁ ‖ hash₁) ‖ path₂ ‖ hash₂) …)` over every evidence file in a fixed order. Change one byte of evidence, or add or remove a file, and the seal changes. Publishing the seal on the day of capture (in a report, a tweet, or a trusted timestamp) fixes the evidence in time without publishing the evidence itself.

**Reproducible analysis.** Findings and both reports are a pure function of the evidence: no clock, no network, no randomness. `khara-check verify` checks every file against the manifest, recomputes the seal, walks the request-log chain, and then re-runs the whole analysis from the raw capture and confirms that `findings.json`, `report.html` and `report.md` match byte for byte. A report that has been edited by hand fails verification.

## 7. Limits, stated plainly

* One run is one observation. Sites change by the hour, by A/B test and by region. Repeat runs are needed before saying "usually".
* Data shared server-to-server (for example the Meta Conversions API) never passes through the browser and cannot be seen. Where a site uses Google server-side tagging, Khara Check can show that the server exists (section 4), but not which companies it forwards the data to.
* A value encrypted, or hashed with a secret key, inside the page cannot be recognised, unless the key travels in the same request. Absence of a finding is not proof of absence.
* The vendor decoders explain fields from public documentation and observed traffic. They help a reader; they are not needed for a finding, which rests on the raw bytes alone.
* "Questions this raises" in the report cite the Digital Personal Data Protection Act, 2023, as prompts for the site to answer. They are not legal conclusions.

## 8. Credit

The Markup's [Blacklight](https://themarkup.org/blacklight) showed that a browser-based tracker inspector could be both rigorous and readable by the public. Khara Check takes a narrower aim: proving that a specific thing a customer typed reached a specific company, across encodings and hashes, with evidence that can be re-verified by anyone.

The server-side tagging check follows Moti, Frings, Utz, Zuiderveen Borgesius and Acar, [“The Bitter Pill: Tracking and Remarketing on EU Pharmacy Websites”](https://gunesacar.net/papers/bitter-pill-pharmacy-privacy-dpm-25.pdf), section 3.4, and their comparison with Fouad, Santos and Laperdrix, “The Devil is in the Details: Detection, Measurement and Lawfulness of Server-Side Tracking on the Web” (Proceedings on Privacy Enhancing Technologies, 2024).
