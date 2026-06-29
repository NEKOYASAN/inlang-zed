# Inlang Zed

> [!IMPORTANT]
> This extension is a work in progress and may not be fully functional.

Inlang Zed brings Inlang and Paraglide message inspection to Zed through LSP:

- inlay hints with the preview translation for message references
- hover tables with all configured locale values
- diagnostics for missing base messages, missing translations, and empty translations
- warning diagnostics for message JSON keys with no references
- code lenses on message JSON keys with workspace reference counts and Zed reference navigation
- an extract-message code action for selected text

The extension discovers `project.inlang/settings.json` files in the current worktree and reads
JSON message files configured through `plugin.inlang.json.pathPattern` or
`plugin.inlang.messageFormat.pathPattern`.

> [!NOTE]
> This extension is heavily inspired by
> [opral/sherlock](https://github.com/opral/sherlock), the VS Code extension for inspecting,
> previewing, editing, and linting Inlang messages.
> 
> The feature set and interaction model intentionally follow Sherlock where Zed's extension and LSP
> APIs make that possible: inline-style translation previews are implemented as inlay hints, hover
> context shows locale messages, diagnostics report missing translations, and extract-message support
> is exposed as a code action.

## Supported References

The language server currently detects these common forms:

```js
t("hello_world")
i18next.t("hello_world")
$t("hello_world")
gettext("hello_world")
msg("hello_world")
formatMessage({ id: "hello_world" })
m.hello_world()
m["hello.world"]()
messages.hello_world()
```

For Paraglide dot calls, Inlang Zed resolves `m.some_key()` to either `some_key` or a dotted
message id whose generated identifier is `some_key`.

## Development

Run the checks:

```sh
npm run check
```

Install the repository as a Zed dev extension from Zed's Extensions view.

Optional Zed settings:

```json
{
  "lsp": {
    "inlang-zed": {
      "initialization_options": {
        "previewLocale": "de",
        "maxHintLength": 80
      }
    }
  }
}
```
