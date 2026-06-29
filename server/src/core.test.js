import fs from "node:fs"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createDiagnostics,
  createDefinition,
  createExtractCodeAction,
  createHover,
  createInlayHints,
  createMessageFileDiagnostics,
  createReferenceCodeLenses,
  createReferences,
  findJsonKeyRange,
  findMessageReferences,
  flattenMessages,
  humanMessageId,
  installSyncFileReader,
  loadWorkspace,
  pathToUri,
  selectProjectForFile,
  upsertFlatJsonMessage,
} from "./core.js"

installSyncFileReader(fs.readFileSync)

test("finds common Inlang Zed message reference forms", () => {
  const references = findMessageReferences(`
    t("hello_world")
    i18next.t('welcome_user')
    m.missing_in_german()
    m["dotted.key"]()
    formatMessage({ id: "format_id" })
  `)

  assert.deepEqual(
    references.map((reference) => reference.rawKey),
    ["hello_world", "welcome_user", "missing_in_german", "dotted.key", "format_id"],
  )
})

test("flattens simple and nested message JSON", () => {
  const messages = flattenMessages({
    hello: "Hello",
    nested: {
      key: "Nested",
    },
    pattern: [{ type: "text", value: "Pattern" }],
  })

  assert.equal(messages.get("hello"), "Hello")
  assert.equal(messages.get("nested.key"), "Nested")
  assert.equal(messages.get("pattern"), "Pattern")
})

test("does not throw while flattening deeply nested message JSON", () => {
  let json = "Deep value"
  for (let index = 0; index < 5000; index += 1) {
    json = { [`level_${index}`]: json }
  }

  assert.doesNotThrow(() => flattenMessages(json))
})

test("loads an Inlang project and returns hints, hover, and diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inlang-zed-"))
  const project = path.join(root, "project.inlang")
  await mkdir(path.join(root, "messages"), { recursive: true })
  await mkdir(project)
  await writeFile(
    path.join(project, "settings.json"),
    JSON.stringify({
      baseLocale: "en",
      locales: ["en", "de"],
      "plugin.inlang.json": { pathPattern: "./messages/{languageTag}.json" },
    }),
  )
  await writeFile(
    path.join(root, "messages", "en.json"),
    JSON.stringify({ hello_world: "Hello world", missing_in_german: "Missing", empty_base: "" }),
  )
  await writeFile(
    path.join(root, "messages", "de.json"),
    JSON.stringify({ hello_world: "Hallo", empty_base: "Leer" }),
  )

  const workspace = await loadWorkspace(root)
  const text = `console.log(t("hello_world"), t("missing_in_german"), t("empty_base"), t("not_found"))`

  const hints = createInlayHints(text, workspace.projects[0], {
    start: { line: 0, character: 0 },
    end: { line: 0, character: text.length },
  })
  assert.deepEqual(
    hints.map((hint) => hint.label.trim()),
    ["Hello world", "Missing", "[empty: empty_base]", "[missing: not_found]"],
  )

  const hover = createHover(text, workspace.projects[0], { line: 0, character: 15 })
  assert.match(hover.contents.value, /hello_world/)
  assert.match(hover.contents.value, /Hallo/)

  const diagnostics = createDiagnostics(text, workspace.projects[0])
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.code),
    ["missing-translation", "empty-translation", "missing-message"],
  )
})

test("rejects configured message paths outside the project root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inlang-zed-contained-"))
  const project = path.join(root, "project.inlang")
  const externalMessageDirName = `${path.basename(root)}-external-messages`
  const externalMessages = path.join(root, "..", externalMessageDirName)
  await mkdir(project)
  await mkdir(externalMessages)
  await writeFile(
    path.join(project, "settings.json"),
    JSON.stringify({
      baseLocale: "en",
      locales: ["en"],
      "plugin.inlang.json": { pathPattern: `../${externalMessageDirName}/{languageTag}.json` },
    }),
  )
  await writeFile(path.join(externalMessages, "en.json"), JSON.stringify({ secret: "leaked" }))

  const workspace = await loadWorkspace(root)
  const loadedProject = workspace.projects[0]

  assert.equal(loadedProject.messageFilesByLocale.has("en"), false)
  assert.deepEqual([...loadedProject.messagesByLocale.get("en").entries()], [])
  assert.match(loadedProject.errors[0], /outside project root/)

  const text = `t("secret")`
  const hover = createHover(text, loadedProject, { line: 0, character: 3 })
  assert.doesNotMatch(hover.contents.value, /leaked/)
  assert.equal(createDefinition(text, loadedProject, { line: 0, character: 3 }), undefined)
  assert.equal(
    createExtractCodeAction({
      documentUri: pathToUri(path.join(root, "src", "page.svelte")),
      text: "Hello",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
      project: loadedProject,
    }),
    undefined,
  )
})

test("places Svelte Paraglide hints after the full call expression", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inlang-zed-svelte-"))
  const project = path.join(root, "project.inlang")
  await mkdir(path.join(root, "messages"), { recursive: true })
  await mkdir(project)
  await writeFile(
    path.join(project, "settings.json"),
    JSON.stringify({
      baseLocale: "ja",
      locales: ["ja", "en"],
      "plugin.inlang.messageFormat": { pathPattern: "./messages/{locale}.json" },
    }),
  )
  await writeFile(path.join(root, "messages", "ja.json"), JSON.stringify({ hero_title: "こんにちは" }))
  await writeFile(path.join(root, "messages", "en.json"), JSON.stringify({ hero_title: "Hello" }))

  const workspace = await loadWorkspace(root)
  const text = `<h1>{m.hero_title()}</h1>`
  const hints = createInlayHints(text, workspace.projects[0])

  assert.equal(hints[0].label.trim(), "こんにちは")
  assert.deepEqual(hints[0].position, { line: 0, character: 20 })
})

test("resolves definitions from Svelte message calls to every locale JSON key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inlang-zed-definition-"))
  const project = path.join(root, "project.inlang")
  await mkdir(path.join(root, "messages"), { recursive: true })
  await mkdir(project)
  await writeFile(
    path.join(project, "settings.json"),
    JSON.stringify({
      baseLocale: "ja",
      locales: ["ja", "en"],
      "plugin.inlang.messageFormat": { pathPattern: "./messages/{locale}.json" },
    }),
  )
  await writeFile(
    path.join(root, "messages", "ja.json"),
    '{\n\t"hero_title": "こんにちは",\n\t"nested": {\n\t\t"title": "ネスト"\n\t}\n}\n',
  )
  await writeFile(path.join(root, "messages", "en.json"), '{\n  "hero_title": "Hello"\n}\n')

  const workspace = await loadWorkspace(root)
  const definitions = createDefinition(`<h1>{m.hero_title()}</h1>`, workspace.projects[0], {
    line: 0,
    character: 8,
  })

  assert.deepEqual(
    definitions.map((definition) => definition.uri.split("/").at(-1)),
    ["ja.json", "en.json"],
  )
  assert.deepEqual(
    definitions.map((definition) => definition.range),
    [
      {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 12 },
      },
      {
        start: { line: 1, character: 3 },
        end: { line: 1, character: 13 },
      },
    ],
  )
})

test("finds nested JSON key ranges for dotted message ids", () => {
  const range = findJsonKeyRange('{\n  "nested": {\n    "title": "Hello"\n  }\n}\n', "nested.title")

  assert.deepEqual(range, {
    start: { line: 2, character: 5 },
    end: { line: 2, character: 10 },
  })
})

test("selects the nearest Inlang project in a monorepo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inlang-zed-monorepo-"))
  const appRoot = path.join(root, "apps", "app")
  const adminRoot = path.join(root, "apps", "app-admin")

  for (const projectRoot of [appRoot, adminRoot]) {
    await mkdir(path.join(projectRoot, "project.inlang"), { recursive: true })
    await mkdir(path.join(projectRoot, "messages"), { recursive: true })
    await writeFile(
      path.join(projectRoot, "project.inlang", "settings.json"),
      JSON.stringify({
        baseLocale: "en",
        locales: ["en"],
        "plugin.inlang.json": { pathPattern: "./messages/{languageTag}.json" },
      }),
    )
    await writeFile(path.join(projectRoot, "messages", "en.json"), JSON.stringify({ title: projectRoot }))
  }

  const workspace = await loadWorkspace(root)
  const selected = selectProjectForFile(
    workspace.projects,
    path.join(adminRoot, "src", "routes", "+page.svelte"),
  )

  assert.equal(selected.projectRoot, adminRoot)
})

test("does not select a prefix sibling as the containing monorepo project", () => {
  const projects = [
    { projectRoot: "/repo/apps/app" },
    { projectRoot: "/repo/apps/app-admin" },
  ]

  assert.equal(
    selectProjectForFile(projects, "/repo/apps/app-admin/src/page.svelte").projectRoot,
    "/repo/apps/app-admin",
  )
})

test("does not guess a project for files outside all monorepo project roots", () => {
  const projects = [
    { projectRoot: "/repo/apps/web" },
    { projectRoot: "/repo/apps/admin" },
  ]

  assert.equal(selectProjectForFile(projects, "/repo/packages/ui/Button.svelte"), undefined)
})

test("uses the only project for files outside its root in a single-project workspace", () => {
  const projects = [{ projectRoot: "/repo/app" }]

  assert.equal(
    selectProjectForFile(projects, "/repo/shared/Button.svelte").projectRoot,
    "/repo/app",
  )
})

test("returns message JSON code lenses with reference counts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inlang-zed-codelens-"))
  const projectPath = path.join(root, "project.inlang")
  const messagePath = path.join(root, "messages", "en.json")
  await mkdir(path.join(root, "src", "routes"), { recursive: true })
  await mkdir(path.join(root, "src", "lib", "paraglide", "messages"), { recursive: true })
  await mkdir(path.dirname(messagePath), { recursive: true })
  await mkdir(projectPath)
  await writeFile(
    path.join(projectPath, "settings.json"),
    JSON.stringify({
      baseLocale: "en",
      locales: ["en"],
      "plugin.inlang.json": { pathPattern: "./messages/{languageTag}.json" },
    }),
  )
  const messageText = '{\n  "title": "Title",\n  "nested": {\n    "key": "Nested"\n  },\n  "unused": "Unused"\n}\n'
  await writeFile(messagePath, messageText)
  await writeFile(
    path.join(root, "src", "routes", "+page.svelte"),
    `<script>import { m } from '$lib/paraglide/messages'</script>\n<h1>{m.title()}</h1>\n<p>{m.title()}</p>\n<p>{m["nested.key"]()}</p>\n`,
  )
  await writeFile(
    path.join(root, "src", "lib", "paraglide", "messages", "generated.js"),
    `export const title = () => "generated"; m.title();\n`,
  )

  const workspace = await loadWorkspace(root)
  const lenses = await createReferenceCodeLenses({
    documentUri: pathToUri(messagePath),
    text: messageText,
    project: workspace.projects[0],
  })

  assert.deepEqual(
    lenses.map((lens) => lens.command.title),
    ["2 references", "1 reference", "0 references"],
  )
  assert.equal(lenses[0].command.command, "editor.action.showReferences")
  assert.deepEqual(lenses[0].command.arguments.slice(0, 2), [
    pathToUri(messagePath),
    { line: 1, character: 3 },
  ])
  assert.equal(lenses[0].command.arguments[2][0].uri, pathToUri(path.join(root, "src", "routes", "+page.svelte")))
  assert.deepEqual(lenses[0].command.arguments[2][0].range, {
    start: { line: 1, character: 7 },
    end: { line: 1, character: 12 },
  })
  assert.equal(lenses[0].command.arguments[2].length, 2)
  assert.equal(lenses[2].command.command, "inlang-zed.noop")
  assert.deepEqual(lenses[2].command.arguments, [])

  const references = await createReferences({
    documentUri: pathToUri(messagePath),
    text: messageText,
    position: { line: 1, character: 4 },
    project: workspace.projects[0],
  })
  assert.deepEqual(
    references.map((reference) => reference.range),
    [
      {
        start: { line: 1, character: 7 },
        end: { line: 1, character: 12 },
      },
      {
        start: { line: 2, character: 6 },
        end: { line: 2, character: 11 },
      },
    ],
  )

  const diagnostics = await createMessageFileDiagnostics({
    documentUri: pathToUri(messagePath),
    text: messageText,
    project: workspace.projects[0],
  })

  assert.deepEqual(
    diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      range: diagnostic.range,
    })),
    [
      {
        code: "unused-message",
        message: "Message 'unused' is not referenced in this Inlang project.",
        range: {
          start: { line: 5, character: 3 },
          end: { line: 5, character: 9 },
        },
      },
    ],
  )
})

test("generates human ids and JSON updates for extract actions", () => {
  assert.equal(humanMessageId("Hello, brave new world!"), "hello_brave_new_world")
  assert.equal(
    upsertFlatJsonMessage('{\n  "hello": "Hello"\n}\n', "new_key", "New value"),
    '{\n  "hello": "Hello",\n  "new_key": "New value"\n}\n',
  )
})

test("extract action uses Paraglide references in Svelte markup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inlang-zed-extract-"))
  const projectPath = path.join(root, "project.inlang")
  const messagesPath = path.join(root, "messages", "en.json")
  await mkdir(path.dirname(messagesPath), { recursive: true })
  await mkdir(projectPath)
  await writeFile(
    path.join(projectPath, "settings.json"),
    JSON.stringify({
      baseLocale: "en",
      locales: ["en"],
      "plugin.inlang.json": { pathPattern: "./messages/{languageTag}.json" },
    }),
  )
  await writeFile(messagesPath, "{\n}\n")

  const workspace = await loadWorkspace(root)
  const text = `<script>\nimport { m } from '$lib/paraglide/messages'\n</script>\n<h1>Hello world</h1>`
  const start = text.indexOf("Hello world")
  const action = createExtractCodeAction({
    documentUri: "file:///src/routes/+page.svelte",
    text,
    range: {
      start: { line: 3, character: start - text.lastIndexOf("\n", start) - 1 },
      end: { line: 3, character: start - text.lastIndexOf("\n", start) - 1 + "Hello world".length },
    },
    project: workspace.projects[0],
  })

  assert.equal(action.edit.changes["file:///src/routes/+page.svelte"][0].newText, "{m.hello_world()}")
})

test("extract action uses expression Paraglide references inside quoted script strings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inlang-zed-extract-script-"))
  const projectPath = path.join(root, "project.inlang")
  const messagesPath = path.join(root, "messages", "en.json")
  await mkdir(path.dirname(messagesPath), { recursive: true })
  await mkdir(projectPath)
  await writeFile(
    path.join(projectPath, "settings.json"),
    JSON.stringify({
      baseLocale: "en",
      locales: ["en"],
      "plugin.inlang.json": { pathPattern: "./messages/{languageTag}.json" },
    }),
  )
  await writeFile(messagesPath, "{\n}\n")

  const workspace = await loadWorkspace(root)
  const text = `<script>\nimport { m } from '$lib/paraglide/messages'\nconst title = "Hello world"\n</script>`
  const start = text.indexOf('"Hello world"')
  const linePrefix = text.lastIndexOf("\n", start)
  const action = createExtractCodeAction({
    documentUri: "file:///src/routes/+page.svelte",
    text,
    range: {
      start: { line: 2, character: start - linePrefix - 1 },
      end: { line: 2, character: start - linePrefix - 1 + '"Hello world"'.length },
    },
    project: workspace.projects[0],
  })

  assert.equal(action.edit.changes["file:///src/routes/+page.svelte"][0].newText, "m.hello_world()")
})
