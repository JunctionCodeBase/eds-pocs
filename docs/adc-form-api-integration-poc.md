# ADC Form — API Integration POC (EDS)

**Question this POC answers:** *Can we replicate the AEM Form Container's API
integration (submit to an enterprise API, dynamic dropdowns, server-side secret)
in AEM Edge Delivery Services (EDS)?*

**Answer: Yes.** Proven end-to-end. The one architectural difference is that EDS
is static hosting, so the server-side half of AEM's Form Container (the Java
servlet) is replaced by a small **serverless proxy**. Everything else maps 1:1.

---

## 1. The core idea

The browser can **never** call the enterprise API directly — the API secret
cannot live in client JavaScript, and CORS/domain rules block it. This is the
same reason AEM uses a server-side `FormSubmitServlet`: AEM's browser code also
posts to the servlet, not to the API.

```
        ❌ NOT possible                          ✅ How it works (this POC)
 ┌────────────────────────┐          ┌────────────┐   ┌─────────┐   ┌──────────┐
 │ EDS form (browser JS)  │── X ───▶ │ EDS form   │──▶│  Proxy  │──▶│ ESL API  │
 │  → ESL API directly    │          │ (browser)  │   │(serverl)│   │          │
 └────────────────────────┘          └────────────┘   └─────────┘   └──────────┘
   secret leaks, CORS,                sends body +       adds secret    returns
   no server runtime                  context headers    + domain       JSON
```

In EDS, the **proxy** (a small serverless function) plays the exact role AEM's
`FormSubmitServlet` + `APILookupService` + OSGi config played.

---

## 2. AEM → EDS mapping

| AEM Form Container concern | AEM implementation | EDS equivalent (this POC) |
| --- | --- | --- |
| Hold secret + API domain + endpoint map | OSGi `.cfg.json` / `APILookupServiceImpl.Config` | Proxy **env vars** (`API_SECRET_KEY`, `API_DOMAIN`, `API_ENDPOINTS`) |
| Resolve `formType` → real URL | `APILookupService.getRelativeAPIEndpointForKey` | Proxy resolver — key **or** direct path |
| Build request headers (app-id, country, language, secret) | `APILookupServiceImpl.prepareRequestHeader` (inherited page props) | Proxy adds `X-Application-Id`, `X-Country-Code`, `X-Preferred-Language`, `X-Origin-Secret` |
| Forward submit to API | `FormSubmitServlet.doPost` → `processRequest(POST)` | Proxy `handleSubmit` → `fetch(POST)` |
| Dynamic dropdown lookup | `LookupDataSource` + `ConvertToDropdownImpl` | Proxy `handleLookup` + `normalizeLookupResponse` |
| Author config (formType, requestType, messages) | Component dialog | UE model fields on the `adc-form` container |
| reCAPTCHA verification | server-side | Proxy verifies `g-recaptcha-response` server-side |

### Authoring property mapping

| AEM `formcontainer` property | EDS field | Example |
| --- | --- | --- |
| `formType` | Form Type (key **or** path) | `/api/v2/public/profile/subscriptions` |
| `requestType` | Request Type (added to body) | `newsletter_subscription` |
| `successMessage` | Success Message | `You're subscribed.` |
| `failureMessage` | Failure Message | `Something went wrong.` |
| `recaptcha` | Recaptcha | `true` / `false` |
| (OSGi `domainName`) | Proxy `API_DOMAIN` env | server-only |
| (OSGi `secretKey`) | Proxy `API_SECRET_KEY` env | server-only |

---

## 3. Two approaches tried

### Approach A — `formType` as a **key** (mapped in the proxy)
- Author sets `formType = newsletter`; proxy `API_ENDPOINTS` maps
  `{"newsletter":"/api/v2/public/profile/subscriptions"}`.
- Pro: the relative path is not exposed in content; matches an allow-list.
- Con: every endpoint must be pre-registered in proxy config.

### Approach B — `formType` as the **direct relative path** (chosen for parity)
- Author sets `formType = /api/v2/public/profile/subscriptions` — exactly how the
  real AEM `formcontainer` node stores it.
- The proxy accepts a raw path (`/...` or `http...`) when it is not a known key,
  so the allow-list still governs mapped keys.
- Pro: 1:1 with existing AEM authoring; no per-endpoint proxy change.

Both are supported. The block sends `x-form-type: <value>`; the proxy resolves
`config.endpoints[value] || (isPath ? value : undefined)`.

---

## 4. What works ✅

- **Form submit → real API → response.** Verified via curl and a public HTTPS
  tunnel. Body carries authored fields **plus** `requestType`.
- **Server-side secret.** `X-Origin-Secret` is added by the proxy; it never
  appears in the browser (confirmed: proxy log shows `secret= present`, the
  browser request has no secret header).
- **Context headers.** `X-Application-Id` / `X-Country-Code` /
  `X-Preferred-Language` derived from page metadata + `<html lang>`.
- **Dynamic dropdowns.** A `select` field with options `lookup:<key>` fetches
  options at runtime from the proxy lookup route (mirrors `ConvertToDropdownImpl`
  response shapes: `response[0].codeValueList` or `response[]`, `errorCode` guard).
- **reCAPTCHA** hook (token added client-side, verified server-side).
- **Authoring in UE** — Form Type, Request Type, messages, and child fields.
- **Two authoring formats** — Universal Editor (container + `adc-form-field`
  items) and DA tables (key/value config rows + field rows).

## 5. What is NOT feasible / differs ⚠️

| AEM feature | EDS status | Notes |
| --- | --- | --- |
| `/bin/adc/form-submit` servlet | **Not possible** | EDS is static; requires the serverless proxy instead |
| Direct browser → API | **Not possible** | Same in AEM — the servlet exists precisely to avoid this |
| `onSuccess`/`onError` state fns (`setSuccessState`) | Simplified | EDS just shows/hides a success/failure message; custom behavior = extra JS |
| `updateRequest` payload transforms (`updateRequestHideGroupedFields`) | Not ported | Would live in `serializeForm` if a specific API needs a reshaped body |
| `exceptionList` (`requestType,ignore`) | Not ported | Field-omission rules; add per API if needed |
| `formEventTracking` / analytics | Not built | Needs a separate EDS analytics hook (RUM / Adobe Data Layer) |
| `onLoadApi` (prefill via GET on load) | Feasible, not built | Would be a second proxy route |

---

## 6. How the form behaves without a proxy

The block is safe to run and author with **no backend**. When the endpoint is
empty or set to `demo`, `adc-form` runs in **demo mode**: it validates the
fields and simulates a successful submission (logged to the console), so the UI
and authoring flow can be verified end to end. Real submission only happens once
a deployed proxy URL is wired in (see below).

### Test the UI in Universal Editor
1. Deploy block + model to `main` (they are served from GitHub via aem-code-sync).
2. Add the **ADC Form** block; hard-reload the canvas (service worker caches JS).
3. Leave **Proxy Endpoint URL** empty (demo mode), set **Form Type** and add an
   `email` field (required).
4. Preview → Submit → the block shows the success message (demo submit is logged
   to the console).

---

## 7. Production path

For real submission the proxy must be deployed as a server-side serverless
function (its own repo/deployment, kept out of the browser):

- **Adobe I/O Runtime** — closest to the AEM stack.
- or a Cloudflare Worker / Vercel / Lambda.

The function holds the secret + API domain in its **env vars**, resolves
`formType` → real URL, adds the `X-Origin-Secret` + context headers, and forwards
the request. Then set the site-level `form-endpoint` metadata (the OSGi-config
equivalent) to the deployed HTTPS URL, and restrict `ALLOWED_ORIGINS` to the EDS
domain. The browser never holds the secret.

---

## 8. Key files

| File | Role |
| --- | --- |
| `blocks/adc-form/adc-form.js` | Block: builds fields, serializes body (+`requestType`), submits, dynamic lookups |
| `blocks/adc-form/adc-form.demo.html` | Local demo incl. the subscriptions example |
| `component-models.json` (`adc-form`) | UE dialog fields (Form Type, Request Type, messages, Proxy URL) |

## 9. Lessons learned

- API integration in EDS is **entirely feasible** — the only non-negotiable is a
  server-side proxy for the secret (identical constraint to AEM's servlet).
- Keep the secret/domain **only** in proxy env vars; the browser sends context
  headers + body, nothing sensitive.
- `formType` can be a **key or a direct path** — supporting the path matches
  existing AEM authoring exactly and avoids per-endpoint config.
- `requestType` is a **body field**, not a header — add it in `serializeForm`.
- Dynamic dropdowns work by fetching `lookup:<key>` options at runtime and
  normalizing the ESL response shapes the AEM `ConvertToDropdownImpl` handled.
- UE is HTTPS → localhost proxies are blocked; always deploy the proxy for real tests.
- Hard-reload the UE canvas after each deploy (service worker serves stale JS).
