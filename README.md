# Model Usage — Hermes Desktop plugin

Claude / Codex subscription usage at a glance in the Hermes Desktop status bar.

- One **double-ring gauge** per provider: outer ring = 5-hour session window, inner ring = weekly window, provider letter in the middle (`C` Claude, `X` Codex).
- Color by **remaining** share: >50% green · 31–50% yellow · 11–30% orange · ≤10% red.
- Click → popover with every window as a bar plus reset countdown. Duplicate pool rows of the same login are merged.
- Gemini: link to Google AI Studio usage (Hermes has no Gemini usage API).
- Read-only: uses the gateway `model.options` usage cache; never touches credentials. Refreshes every minute.
- UI strings: English, 한국어, 日本語.

## Install

```bash
hermes plugins install Mirinai307/hermes-plugin-model-usage
```

Then open **Capabilities → Plugins** in Hermes Desktop and switch **Model Usage** on (desktop halves install disabled).

## License

MIT
