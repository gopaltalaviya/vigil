# Product videos

`record.mjs` records a narrated video of the web app from a scene list in `scenes/`.

```sh
node --env-file=.env scripts/video/record.mjs overview http://127.0.0.1:8090
```

| Scene list | Output                     | Content                                                                     |
| ---------- | -------------------------- | --------------------------------------------------------------------------- |
| `overview` | `media/vigil-overview.mp4` | The concept in about a minute                                               |
| `demo`     | `media/vigil-demo.mp4`     | The full demo, under three minutes. Sends two 0.01 QOR testnet transactions |
| `security` | `media/vigil-security.mp4` | How a forged batch is caught                                                |

It drives a headless Chrome over the DevTools protocol at 1440×810, captures the screen, speaks
each scene's narration with a built-in Windows voice (`narrate.ps1`), and joins the scenes into an
H.264 MP4 at 1920×1080 with ffmpeg. Title and end cards use `brand/cover.png`.

Requirements: Google Chrome (`CHROME_PATH`), ffmpeg and ffprobe (on `PATH`, or the folder that
holds them in `FFMPEG_DIR`) and Windows PowerShell.

A `type` step with `env` reads its value from the named environment variable and types it into
the field; the value is never written to disk or to the log. `media/` is ignored by git.

## Scene steps

| Action               | Fields                               | Effect                                        |
| -------------------- | ------------------------------------ | --------------------------------------------- |
| `load`               | `hash`, `ms`                         | Opens the app at a route                      |
| `goto`               | `hash`, `ms`                         | Changes route without reloading               |
| `theme`              | `theme`                              | `light`, `dark` or `system`                   |
| `click`              | `selector`, `ms`                     | Moves the pointer to an element and clicks it |
| `type`               | `selector`, `text` or `env`, `delay` | Types into a field                            |
| `scroll`, `scrollTo` | `y` or `selector`, `block`           | Smooth scrolling                              |
| `wait`               | `ms`                                 | Holds the shot                                |
| `waitFor`            | `js`, `timeoutMs`                    | Waits off camera until the expression is true |
| `waitForSelector`    | `selector`, `timeoutMs`              | Waits until an element exists                 |
| `hidePointer`        |                                      | Hides the pointer                             |

Steps under `before` run off camera; `steps` are recorded. A scene with `card` shows an image.
