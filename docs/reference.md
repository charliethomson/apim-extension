# Reference

Every command, setting, quick fix and header expansion. The [guide](guide.md) explains them by
task.

## Commands

All are under **APIM:** in the command palette.

| Command | Where | What it does |
|---|---|---|
| Connect to an Instance | palette, API Management view | Signs in, lists your subscriptions and API Management services, and sets `apimPolicy.instance` |
| Sign In to Azure | palette | Signs in with VS Code's Microsoft account without choosing an instance |
| Refresh Instance | API Management view | Reads the instance again now, ignoring `apimPolicy.instanceCacheMinutes` |
| Open a Policy from the Instance | palette | Picks a scope (global, product, API, operation, fragment) and opens its policy read-only |
| Set This Policy's Scope | palette, on a policy | Ties a local policy file to a scope on the instance, when its path doesn't say |
| Use as This Policy's Scope | API Management view, right-click a scope | The same, picked from the view |
| Open Policy | API Management view, click a scope | Opens that scope's policy read-only |
| Copy Reference | API Management view, on a named value | Copies `{{name}}` |
| Open as Editable | read-only instance policy (pencil button), API Management view | Opens a copy you can edit. Saving keeps a draft in memory |
| Reload from Instance | editable copy | Throws the draft away and reads the instance again |
| Push to Instance | local policy file or editable copy (cloud button) | Pulls what's live and opens a diff against your version. Writes nothing |
| Push These Changes | the push diff (check button) | Writes your version, if the live one hasn't changed since the pull |
| Cancel Push | the push diff | Closes the diff without writing |
| Generate Docs | palette, on a policy | Previews a Markdown page for the open policy or fragment |
| Write Fragment Docs | palette | Writes a Markdown page beside every fragment in the workspace |

## Settings

| Setting | Default | |
|---|---|---|
| `apimPolicy.files.include` | `[]` | Extra globs for policy files, e.g. `**/policies/**/*.xml` |
| `apimPolicy.files.detectByContent` | `true` | Treat XML with a `<policies>` or `<fragment>` root as a policy |
| `apimPolicy.csharp.enabled` | `true` | C# features inside expressions |
| `apimPolicy.lint.unguardedVariableAccess` | `off` | Flag `context.Variables["x"]` where `x` may be unset: `information` or `warning` |
| `apimPolicy.lint.missingInput` | `warning` | An include whose required `@in` nothing sets: `information` or `off` |
| `apimPolicy.allowedTypes.severity` | `error` | Types and members APIM doesn't allow, or `off` |
| `apimPolicy.instance` | | The instance to read from, as its ARM resource ID |
| `apimPolicy.tenant` | | The instance's Entra tenant, when it isn't your account's default |
| `apimPolicy.armEndpoint` | `https://management.azure.com` | Resource Manager endpoint, for sovereign clouds |
| `apimPolicy.instanceCacheMinutes` | `10` | How long what's read from the instance is reused |
| `apimPolicy.publish.allowedInstances` | `[]` | Instances Push to Instance may write to. Empty means pushing is off |

## Quick fixes and refactors

Ctrl/Cmd+. on the line shows them.

### On includes

| Action | Shown on |
|---|---|
| Set 'x' before this include, or Set the N required inputs before this include | An `include-fragment` whose required inputs nothing earlier sets. Adds a `set-variable` for each, with its default or an empty value of its type |
| Set every input of 'id' (N) | Any `include-fragment` with inputs nothing sets, optional ones too. JSON inputs are built out key by key |

### On variables

| Action | Shown on |
|---|---|
| Fill in 'x' | A `set-variable` with an empty value (`""`, `@()`, `@{}`) for a variable whose type is declared |
| Use GetValueOrDefault for 'x' | A read flagged by `apimPolicy.lint.unguardedVariableAccess` |

### On a fragment and its header

| Action | Shown on |
|---|---|
| Add a header documenting @in and @out | The `<fragment>` tag of a fragment with no header |
| Document 'x' as @in | A variable the fragment reads but neither sets nor documents. Marked optional, with a default, when every read is guarded |
| Document 'x' as @internal, Document 'x' as @out | A variable the fragment sets that the header doesn't declare |
| Document every undeclared variable as @internal (N) | The same, all at once. Tab moves through their descriptions |
| Treat every 'prefix-*' variable as internal | The same, adding a pattern for the variable's prefix |
| Treat every undocumented variable as internal (@internal *) | The same, opting the whole fragment out |
| Set 'x' at the start of the fragment, or Set the N outputs at the start of the fragment | An `@out` not set on every path. Sets it to an empty value first, so every path leaves one |
| Generate a @typedef for 'x' | A header tag typed `JObject`, `JArray`, `JToken`, an inline object type or nothing, when the shape is known |
| Write X as @property lines | An old one-line `@typedef {{ … }} X` |
| Extract this JObject shape to a @typedef | A `new JObject { … }` in a fragment |

## Header expansions

At the start of a line in a fragment header, `@` offers these. Above an undocumented
`<fragment>`, `<!--` offers **Fragment header**, a header drafted from the fragment.

| Expansion | Writes |
|---|---|
| `@in` for each variable read but not documented | `@in` with its type and, when optional, its default |
| `@out`, `@internal` for each variable set but not documented | The tag with its type |
| `@in` | `@in  {string} name  description` |
| `@in [optional]` | `@in  {string} [name=default]  description` |
| `@out` | `@out {string} name  description` |
| `@internal` | `@internal name-or-prefix-*  description` |
| `@typedef` | `@typedef Name  description` and one `@property` line |
| `@property` | `@property {string} key  description` |

## Navigation

Ctrl/Cmd+click, or Go to Definition, works from:

- a `fragment-id` to the fragment: the workspace file, or from a policy opened from the instance,
  the instance's copy;
- a `set-variable` name to the `@in` of the fragment it's for, or the fragment's own `@out` or
  `@internal` line;
- a typedef name in a header tag's `{type}` to its `@typedef` line;
- a C# local to its declaration, and a C# symbol to its stub.
