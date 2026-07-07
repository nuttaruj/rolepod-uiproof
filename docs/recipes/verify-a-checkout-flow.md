# Recipe — Verify a checkout flow end-to-end

Goal: prove that a real user can add an item to cart and reach the
order-confirmation page after a UI change.

## 1. Drive `/verify-ui` from your AI agent

Conversational prompt (Claude Code, Cursor, etc.):

> Use /verify-ui to drive https://shop.example.com through:
> click "Add to cart" on the first product, click "Checkout", fill
> Email with "a@b.com", click "Place order". Expect the URL to match
> `/order/[0-9]+` and the text "Order confirmed" to be visible.

The skill builds the `verify_ui_flow` input:

```json
{
  "mode": "assert",
  "open": { "platform": "web", "url": "https://shop.example.com" },
  "steps": [
    { "kind": "click", "query": "Add to cart" },
    { "kind": "click", "query": "Checkout" },
    { "kind": "type", "query": "Email", "text": "a@b.com" },
    { "kind": "click", "query": "Place order" }
  ],
  "expect": [
    { "kind": "url_matches", "pattern": "/order/[0-9]+" },
    { "kind": "text_visible", "text": "Order confirmed" }
  ],
  "capture": ["screenshot"],
  "close_on_finish": true
}
```

Result includes `run_id`, `passed`, `evidence_paths.screenshots`,
`evidence_paths.replay_bundle`.

## 2. Convert to a Playwright Test once the flow stabilises

```
/scaffold-e2e from .rolepod-uiproof/artifacts/verify_…/replay.json
using playwright-test framework
```

Generates a `.spec.ts` under
`./.rolepod-uiproof/artifacts/scaffold_…/`. Move it into
`tests/e2e/checkout.spec.ts`, install `@playwright/test`, and the
flow now runs in CI without an AI agent.

## 3. Hand the bundle to `rolepod-uiproof replay` for headless re-runs

```
npx @rolepod/uiproof replay .rolepod-uiproof/artifacts/verify_…/replay.json
```

Exit code `0` if it passes, `1` otherwise. Useful as a pre-deploy
smoke step that doesn't require a full Playwright Test setup.
