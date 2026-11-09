# CS442 · ICA4 student workspace

Buildless Chinese student frontend for the frozen `ica4-v1` classroom service. Host this directory as the root of a GitHub Pages project. All assets use relative URLs, including under `/cs442-ica4/`.

## Configure the classroom API

Set the public `apiBaseUrl` in `config.json` to the teacher-provided, externally reachable **HTTPS service root**. The initial deployment uses a verified temporary Cloudflare Quick Tunnel. Restarting that tunnel changes its address, so update this configuration after a restart; use a stable owned HTTPS endpoint for scheduled classes. Students can edit this address before login. An empty address displays explicit setup instructions. `/api/v1` is normalized if pasted; other paths, query parameters, URL credentials and HTTP are rejected.

The API must permit the exact Pages origin `https://ethanzx-usslab.github.io` through its opt-in CORS configuration, including `Authorization`, `Content-Type`, `Idempotency-Key`, and exposed `Content-Disposition`. No cross-origin cookie session is used. Static hosting alone does not provide the Python service.

Expected public identities are pinned in `assets/api.js`: protocol `ica4-v1`, asset version `ica4-assets-442-v1`, model versions `baseline-61b9c7843367` and `regularized-45b4d9a7215d`. These version identifiers contain no model weights. Unexpected identities stop the session. Signed receipts are displayed as supplied by the API; signature verification remains with the teacher.

## Students

Obtain your own group Token and API address through the teacher's course channel. Paste the Token into the login form. It is kept in page memory and sent only in Bearer headers, with cookies omitted. Reloading or logging out requires re-entry. Downloads use authenticated requests and temporary Blob URLs. The Notebook example prompts for its Token interactively.

The dashboard reads session, usage, manifest and evidence only. It never calls prediction or evaluation routes. Run experiments and formal evaluations in the downloaded Notebook. During the submission phase, after membership evaluation freezes, submit a conclusion containing actual numerical evidence and limitations. Draft text remains in page memory during polling; reloading discards it. Interrupted submissions reuse their idempotency key when retried unchanged in the same page.

## Local verification

Node.js 24 or newer; no packages or build step:

```sh
npm test
node --check assets/api.js
node --check assets/app.js
```

In environments that prohibit child processes, use `node --test --test-isolation=none` instead. Tests use synthetic, non-secret credentials and injected fetch responses. Browser testing with a real HTTPS API remains necessary for CORS, download behavior and responsive rendering.

Serve the directory over HTTP locally using any static server; opening `index.html` with `file://` does not provide ES module/config loading. Configure a real HTTPS API for authenticated experiments.

## Public contents

Only this standalone frontend belongs in the public repository. No Teacher materials, credentials, server state, database, target model weights, private membership truth, original project history, analytics, CDN scripts or third-party resources are included. Experiment files are delivered through authenticated API downloads. No deployment workflow is required for branch-based Pages hosting.
