# Contributing

Thank you for helping. Khara Check is used as evidence, so the bar is correctness first.

* **Run the tests.** `npm install`, `npx playwright install chromium`, then `npm test`. All tests must pass.
* **Never test against a real site in the test suite.** Add a scenario to the practice site in `fixtures/site` instead, with an expected-findings file in `fixtures/expected`.
* **A new decoder** goes in `src/decoders`, says where its field meanings come from (public documentation or observed traffic), and comes with a practice scenario that exercises it.
* **No evasion.** Pull requests that disguise automation, alter browser fingerprints or solve CAPTCHAs will not be merged.
* **Never commit real personal data.** Planted values are generated or fake. Evidence folders from real sites can hold cookies and identifiers: do not attach them to public issues.

To report a finding about a company, write to hello@kharaindex.in rather than opening an issue.
