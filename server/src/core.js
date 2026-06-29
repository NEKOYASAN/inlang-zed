import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".svelte-kit",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
])
const SOURCE_EXTENSIONS = new Set([
  ".astro",
  ".html",
  ".js",
  ".jsx",
  ".mjs",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
])
const DEFAULT_MAX_HINT_LENGTH = 80

export function uriToPath(uri) {
  if (!uri?.startsWith("file://")) return undefined
  return fileURLToPath(uri)
}

export function pathToUri(filePath) {
  return pathToFileURL(filePath).toString()
}

export function positionToOffset(text, position) {
  let line = 0
  let character = 0

  for (let index = 0; index < text.length; index += 1) {
    if (line === position.line && character === position.character) {
      return index
    }

    if (text[index] === "\n") {
      line += 1
      character = 0
    } else {
      character += 1
    }
  }

  return text.length
}

export function offsetToPosition(text, offset) {
  let line = 0
  let character = 0
  const cappedOffset = Math.max(0, Math.min(offset, text.length))

  for (let index = 0; index < cappedOffset; index += 1) {
    if (text[index] === "\n") {
      line += 1
      character = 0
    } else {
      character += 1
    }
  }

  return { line, character }
}

export function rangeForOffsets(text, startOffset, endOffset) {
  return {
    start: offsetToPosition(text, startOffset),
    end: offsetToPosition(text, endOffset),
  }
}

export function getTextInRange(text, range) {
  return text.slice(positionToOffset(text, range.start), positionToOffset(text, range.end))
}

export function rangeContains(range, position) {
  if (position.line < range.start.line || position.line > range.end.line) return false
  if (position.line === range.start.line && position.character < range.start.character) return false
  if (position.line === range.end.line && position.character > range.end.character) return false
  return true
}

export function rangesIntersect(a, b) {
  return (
    comparePositions(a.start, b.end) <= 0 &&
    comparePositions(b.start, a.end) <= 0
  )
}

function comparePositions(a, b) {
  if (a.line !== b.line) return a.line - b.line
  return a.character - b.character
}

export async function discoverProjects(rootPath) {
  const projects = []
  if (!rootPath) return projects

  async function walk(directory) {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    if (entries.some((entry) => entry.isFile() && entry.name === "settings.json")) {
      if (directory.endsWith(".inlang")) {
        projects.push(directory)
        return
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
      await walk(path.join(directory, entry.name))
    }
  }

  await walk(rootPath)
  return projects
}

export async function loadWorkspace(rootPath, settings = {}) {
  const projectPaths = await discoverProjects(rootPath)
  const projects = []

  for (const projectPath of projectPaths) {
    const project = await loadProject(projectPath, settings)
    if (project) projects.push(project)
  }

  return {
    rootPath,
    projects,
    settings,
  }
}

export function selectProjectForFile(projects, filePath) {
  if (projects.length === 0) return undefined
  if (!filePath) return projects[0]

  const containingProjects = projects.filter((project) => isPathInside(filePath, project.projectRoot))
  if (containingProjects.length === 0) {
    return projects.length === 1 ? projects[0] : undefined
  }

  return containingProjects.sort((a, b) => b.projectRoot.length - a.projectRoot.length)[0]
}

function isPathInside(filePath, projectRoot) {
  const relativePath = path.relative(projectRoot, filePath)
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
}

export async function loadProject(projectPath, settings = {}) {
  const settingsPath = path.join(projectPath, "settings.json")
  const parsedSettings = await readJson(settingsPath)
  if (!parsedSettings) return undefined

  const locales = Array.isArray(parsedSettings.locales)
    ? parsedSettings.locales.filter((locale) => typeof locale === "string")
    : []
  const baseLocale =
    typeof settings.baseLocale === "string"
      ? settings.baseLocale
      : typeof parsedSettings.baseLocale === "string"
        ? parsedSettings.baseLocale
        : locales[0]
  const previewLocale =
    typeof settings.previewLocale === "string" && locales.includes(settings.previewLocale)
      ? settings.previewLocale
      : baseLocale
  const pathPattern = getPathPattern(parsedSettings)

  if (!baseLocale || !pathPattern || locales.length === 0) {
    return {
      projectPath,
      projectRoot: path.dirname(projectPath),
      settingsPath,
      settings: parsedSettings,
      baseLocale,
      previewLocale,
      locales,
      pathPattern,
      messagesByLocale: new Map(),
      messageFilesByLocale: new Map(),
      errors: ["Missing baseLocale, locales, or plugin.inlang.json.pathPattern."],
    }
  }

  const messagesByLocale = new Map()
  const messageFilesByLocale = new Map()
  const errors = []
  const projectRoot = path.dirname(projectPath)

  for (const locale of locales) {
    const messageFile = path.resolve(
      projectRoot,
      pathPattern.replaceAll("{languageTag}", locale).replaceAll("{locale}", locale),
    )
    if (!isPathInside(messageFile, projectRoot)) {
      errors.push(`Ignoring message path for locale '${locale}' outside project root: ${messageFile}.`)
      messagesByLocale.set(locale, new Map())
      continue
    }
    messageFilesByLocale.set(locale, messageFile)

    const messages = await readJson(messageFile)
    if (!messages) {
      errors.push(`Could not read messages for locale '${locale}' at ${messageFile}.`)
      messagesByLocale.set(locale, new Map())
      continue
    }
    messagesByLocale.set(locale, flattenMessages(messages))
  }

  return {
    projectPath,
    projectRoot,
    settingsPath,
    settings: parsedSettings,
    baseLocale,
    previewLocale,
    locales,
    pathPattern,
    messagesByLocale,
    messageFilesByLocale,
    errors,
  }
}

function getPathPattern(settings) {
  const jsonPattern = settings?.["plugin.inlang.json"]?.pathPattern
  const messageFormatPattern = settings?.["plugin.inlang.messageFormat"]?.pathPattern
  return typeof jsonPattern === "string"
    ? jsonPattern
    : typeof messageFormatPattern === "string"
      ? messageFormatPattern
      : undefined
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch {
    return undefined
  }
}

export function flattenMessages(json) {
  const messages = new Map()
  const stack = [{ value: json, keyPath: "", isRoot: true }]

  while (stack.length > 0) {
    const { value, keyPath, isRoot } = stack.pop()

    if (isRoot && isPlainObject(value)) {
      pushNestedMessages(stack, value, "", true)
      continue
    }

    const text = stringifyMessageValue(value)
    if (typeof text === "string") {
      messages.set(keyPath, text)
      continue
    }

    if (isPlainObject(value)) {
      pushNestedMessages(stack, value, keyPath, false)
    }
  }

  return messages
}

function pushNestedMessages(stack, value, keyPath, isRoot) {
  const entries = Object.entries(value)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const [key, nestedValue] = entries[index]
    if (isRoot && key === "$schema") continue
    stack.push({
      value: nestedValue,
      keyPath: keyPath ? `${keyPath}.${key}` : key,
      isRoot: false,
    })
  }
}

export function stringifyMessageValue(value) {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return stringifyPattern(value)
  if (!isPlainObject(value)) return undefined

  if (typeof value.message === "string") return value.message
  if (typeof value.value === "string") return value.value
  if (Array.isArray(value.pattern)) return stringifyPattern(value.pattern)
  if (Array.isArray(value.variants)) {
    const variant = value.variants.find((candidate) => Array.isArray(candidate?.pattern))
    if (variant) return stringifyPattern(variant.pattern)
  }

  return undefined
}

function stringifyPattern(pattern) {
  return pattern
    .map((element) => {
      if (typeof element === "string") return element
      if (element?.type === "text") return element.value ?? ""
      if (element?.type === "expression") {
        const arg = element.arg
        if (arg?.type === "variable-reference") return `{${arg.name}}`
        if (arg?.type === "literal") return String(arg.value ?? "")
      }
      return ""
    })
    .join("")
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function findMessageReferences(text) {
  const references = []
  const seen = new Set()

  const patterns = [
    {
      regex: /\b(?:[\w$]+\.)?(?:t|\$t|gettext|msg)\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
      keyGroup: 2,
      keyOffset: (match) => match[0].lastIndexOf(match[2]),
      kind: "call",
    },
    {
      regex: /\b(?:i18next|i18n|intl)\.t\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
      keyGroup: 2,
      keyOffset: (match) => match[0].lastIndexOf(match[2]),
      kind: "call",
    },
    {
      regex: /\bformatMessage\s*\(\s*\{\s*id\s*:\s*(["'`])([^"'`]+)\1[^}]*\}\s*\)/g,
      keyGroup: 2,
      keyOffset: (match) => match[0].lastIndexOf(match[2]),
      kind: "formatMessage",
    },
    {
      regex: /\b(?:m|messages)\s*\[\s*(["'`])([^"'`]+)\1\s*\]\s*(?:\(\s*\))?/g,
      keyGroup: 2,
      keyOffset: (match) => match[0].lastIndexOf(match[2]),
      kind: "paraglide-bracket",
    },
    {
      regex: /\b(?:m|messages)\.([A-Za-z_$][\w$]*)\s*\(\s*\)/g,
      keyGroup: 1,
      keyOffset: (match) => match[0].indexOf(match[1]),
      kind: "paraglide-dot",
    },
  ]

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const rawKey = match[pattern.keyGroup]
      const startOffset = match.index + pattern.keyOffset(match)
      const endOffset = startOffset + rawKey.length
      const id = `${startOffset}:${endOffset}:${rawKey}`
      if (seen.has(id)) continue
      seen.add(id)

      references.push({
        rawKey,
        range: rangeForOffsets(text, startOffset, endOffset),
        fullRange: rangeForOffsets(text, match.index, match.index + match[0].length),
        kind: pattern.kind,
      })
    }
  }

  return references.sort((a, b) => comparePositions(a.range.start, b.range.start))
}

export function resolveMessageId(project, rawKey) {
  const baseMessages = project.messagesByLocale.get(project.baseLocale) ?? new Map()
  if (baseMessages.has(rawKey)) return rawKey

  for (const key of baseMessages.keys()) {
    if (key.replaceAll(".", "_") === rawKey) return key
  }

  return rawKey
}

export function translationFor(project, rawKey, locale = project.previewLocale) {
  const messageId = resolveMessageId(project, rawKey)
  const messages = project.messagesByLocale.get(locale) ?? new Map()
  return {
    messageId,
    message: messages.get(messageId),
    exists: messages.has(messageId),
  }
}

export function createInlayHints(text, project, range, settings = {}) {
  const maxLength = Number.isInteger(settings.maxHintLength)
    ? settings.maxHintLength
    : DEFAULT_MAX_HINT_LENGTH

  return findMessageReferences(text)
    .filter((reference) => !range || rangesIntersect(reference.range, range))
    .map((reference) => {
      const { messageId, message, exists } = translationFor(project, reference.rawKey)
      const label = exists
        ? message.trim() === ""
          ? `[empty: ${messageId}]`
          : truncate(resolveEscapedCharacters(message), maxLength)
        : `[missing: ${messageId}]`

      return {
        position: hintPosition(text, reference),
        label: ` ${label}`,
        kind: 1,
        paddingLeft: true,
      }
    })
}

function hintPosition(text, reference) {
  const fullRangeEndOffset = positionToOffset(text, reference.fullRange.end)
  const nextNonWhitespaceMatch = text.slice(fullRangeEndOffset).match(/^\s*}/)
  if (nextNonWhitespaceMatch) {
    return offsetToPosition(text, fullRangeEndOffset + nextNonWhitespaceMatch[0].length)
  }

  return reference.fullRange.end
}

export function createHover(text, project, position) {
  const reference = findMessageReferences(text).find((candidate) =>
    rangeContains(candidate.range, position),
  )
  if (!reference) return undefined

  const messageId = resolveMessageId(project, reference.rawKey)
  const rows = project.locales
    .map((locale) => {
      const message = project.messagesByLocale.get(locale)?.get(messageId)
      return `| ${escapeMarkdown(locale)} | ${escapeMarkdown(typeof message === "string" ? message : "[missing]")} |`
    })
    .join("\n")

  return {
    contents: {
      kind: "markdown",
      value: `**${escapeMarkdown(messageId)}**\n\n| Locale | Message |\n| --- | --- |\n${rows}`,
    },
    range: reference.range,
  }
}

export function createDefinition(text, project, position) {
  const reference = findMessageReferences(text).find((candidate) =>
    rangeContains(candidate.range, position),
  )
  if (!reference) return undefined

  const messageId = resolveMessageId(project, reference.rawKey)
  const locations = []

  for (const locale of project.locales) {
    const messageFile = project.messageFilesByLocale.get(locale)
    if (!messageFile) continue

    const messageFileText = readFileSyncSafe(messageFile)
    if (messageFileText === undefined) continue

    const range = findJsonKeyRange(messageFileText, messageId)
    if (!range) continue

    locations.push({
      uri: pathToUri(messageFile),
      range,
    })
  }

  return locations.length > 0 ? locations : undefined
}

export async function createReferences({ documentUri, text, position, project }) {
  const messageId = messageIdAtPositionInMessageFile({ documentUri, text, position, project })
  if (!messageId) return []

  return findProjectReferenceLocations(project, messageId)
}

export function createDiagnostics(text, project) {
  const diagnostics = []

  for (const reference of findMessageReferences(text)) {
    const messageId = resolveMessageId(project, reference.rawKey)
    const baseMessages = project.messagesByLocale.get(project.baseLocale)
    const baseMessage = baseMessages?.get(messageId)

    if (!baseMessages?.has(messageId)) {
      diagnostics.push({
        range: reference.range,
        severity: 1,
        source: "Inlang Zed",
        code: "missing-message",
        message: `Message '${messageId}' is missing in base locale '${project.baseLocale}'.`,
      })
      continue
    }

    for (const locale of project.locales) {
      const message = project.messagesByLocale.get(locale)?.get(messageId)
      if (typeof message !== "string") {
        diagnostics.push({
          range: reference.range,
          severity: 2,
          source: "Inlang Zed",
          code: "missing-translation",
          message: `Message '${messageId}' is missing for locale '${locale}'.`,
        })
      } else if (message.trim() === "") {
        diagnostics.push({
          range: reference.range,
          severity: 2,
          source: "Inlang Zed",
          code: "empty-translation",
          message: `Message '${messageId}' has an empty translation for locale '${locale}'.`,
        })
      }
    }
  }

  return diagnostics
}

export async function createReferenceCodeLenses({ documentUri, text, project }) {
  const documentPath = uriToPath(documentUri)
  if (!documentPath || !isMessageFile(project, documentPath)) return []

  const messages = parseMessagesFromText(text)
  if (!messages) return []

  const referenceCounts = await countProjectReferences(project)
  const referenceLocationsByMessage = await findProjectReferenceLocationsByMessage(project)
  const lenses = []

  for (const messageId of messages.keys()) {
    const range = findJsonKeyRange(text, messageId)
    if (!range) continue

    const count = referenceCounts.get(messageId) ?? 0
    const referenceLocations = referenceLocationsByMessage.get(messageId) ?? []
    const firstReference = referenceLocations[0]
    lenses.push({
      range,
      command: {
        title: `${count} ${count === 1 ? "reference" : "references"}`,
        command: firstReference ? "editor.action.showReferences" : "inlang-zed.noop",
        arguments: firstReference ? [documentUri, range.start, referenceLocations] : [],
      },
    })
  }

  return lenses
}

export async function createMessageFileDiagnostics({ documentUri, text, project }) {
  const documentPath = uriToPath(documentUri)
  if (!documentPath || !isMessageFile(project, documentPath)) return undefined

  const messages = parseMessagesFromText(text)
  if (!messages) return []

  const referenceCounts = await countProjectReferences(project)
  return [...messages.entries()]
    .flatMap(([messageId]) => {
      const diagnostics = []
      const range = findJsonKeyRange(text, messageId)
      if (!range) return diagnostics

      if ((referenceCounts.get(messageId) ?? 0) === 0) {
        diagnostics.push({
          range,
          severity: 2,
          source: "Inlang Zed",
          code: "unused-message",
          message: `Message '${messageId}' is not referenced in this Inlang project.`,
        })
      }

      return diagnostics
    })
}

async function findProjectReferenceLocations(project, messageId) {
  return (await findProjectReferenceLocationsByMessage(project)).get(messageId) ?? []
}

async function findProjectReferenceLocationsByMessage(project) {
  const locationsByMessage = new Map()

  for (const filePath of await discoverSourceFiles(project.projectRoot)) {
    const text = await readText(filePath)
    if (text === undefined) continue

    for (const reference of findMessageReferences(text)) {
      const messageId = resolveMessageId(project, reference.rawKey)

      const locations = locationsByMessage.get(messageId) ?? []
      locations.push({
        uri: pathToUri(filePath),
        range: reference.range,
      })
      locationsByMessage.set(messageId, locations)
    }
  }

  return locationsByMessage
}

function messageIdAtPositionInMessageFile({ documentUri, text, position, project }) {
  const documentPath = uriToPath(documentUri)
  if (!documentPath || !isMessageFile(project, documentPath)) return undefined

  const messages = parseMessagesFromText(text)
  if (!messages) return undefined

  for (const messageId of messages.keys()) {
    const range = findJsonKeyRange(text, messageId)
    if (range && rangeContains(range, position)) return messageId
  }

  return undefined
}

function isMessageFile(project, filePath) {
  return [...project.messageFilesByLocale.values()].some(
    (messageFilePath) => path.resolve(messageFilePath) === path.resolve(filePath),
  )
}

function parseMessagesFromText(text) {
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? flattenMessages(parsed) : undefined
  } catch {
    return undefined
  }
}

async function countProjectReferences(project) {
  const counts = new Map()

  for (const filePath of await discoverSourceFiles(project.projectRoot)) {
    const text = await readText(filePath)
    if (text === undefined) continue

    for (const reference of findMessageReferences(text)) {
      const messageId = resolveMessageId(project, reference.rawKey)
      counts.set(messageId, (counts.get(messageId) ?? 0) + 1)
    }
  }

  return counts
}

async function discoverSourceFiles(rootPath) {
  const files = []

  async function walk(directory) {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || isGeneratedParaglidePath(entryPath)) continue
        await walk(entryPath)
        continue
      }

      if (!entry.isFile()) continue
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue
      if (isGeneratedParaglidePath(entryPath)) continue
      files.push(entryPath)
    }
  }

  await walk(rootPath)
  return files
}

function isGeneratedParaglidePath(filePath) {
  return path
    .normalize(filePath)
    .split(path.sep)
    .some((part) => part === "paraglide" || part === ".paraglide")
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch {
    return undefined
  }
}

export function createExtractCodeAction({ documentUri, text, range, project }) {
  const selection = normalizeSelection(getTextInRange(text, range))
  if (!selection.text) return undefined

  const baseMessageFile = project.messageFilesByLocale.get(project.baseLocale)
  const baseMessages = project.messagesByLocale.get(project.baseLocale)
  if (!baseMessageFile || !baseMessages) return undefined

  const messageId = uniqueMessageId(humanMessageId(selection.text), baseMessages)
  const messageFileUri = pathToUri(baseMessageFile)
  const messageFileText = readFileSyncSafe(baseMessageFile)
  if (messageFileText === undefined) return undefined

  const nextMessageFileText = upsertFlatJsonMessage(messageFileText, messageId, selection.text)
  if (nextMessageFileText === undefined) return undefined

  const replacement = messageReferenceReplacement({
    documentUri,
    text,
    range,
    messageId,
    selectedTextWasQuoted: selection.wasQuoted,
  })

  return {
    title: `Inlang Zed: Extract '${messageId}'`,
    kind: "refactor.extract",
    edit: {
      changes: {
        [documentUri]: [
          {
            range,
            newText: replacement,
          },
        ],
        [messageFileUri]: [
          {
            range: wholeDocumentRange(messageFileText),
            newText: nextMessageFileText,
          },
        ],
      },
    },
  }
}

function readFileSyncSafe(filePath) {
  try {
    return String(globalThis.__inlangZedReadFileSync(filePath))
  } catch {
    return undefined
  }
}

export function installSyncFileReader(readFileSync) {
  globalThis.__inlangZedReadFileSync = readFileSync
}

export function upsertFlatJsonMessage(text, messageId, message) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isPlainObject(parsed)) return undefined

  parsed[messageId] = message
  const indent = text.includes("\n\t") ? "\t" : 2
  const trailingNewline = text.endsWith("\n")
  return `${JSON.stringify(parsed, null, indent)}${trailingNewline ? "\n" : ""}`
}

export function findJsonKeyRange(text, messageId) {
  const token = findJsonPropertyToken(text, messageId)
  return token ? rangeForOffsets(text, token.keyStartOffset, token.keyEndOffset) : undefined
}

function findJsonPropertyToken(text, messageId) {
  const directToken = findFlatJsonPropertyToken(text, messageId)
  if (directToken) return directToken

  const parts = messageId.split(".")
  if (parts.length < 2) return undefined

  return findNestedJsonPropertyToken(text, parts)
}

function findFlatJsonPropertyToken(text, key) {
  for (const token of jsonPropertyTokens(text)) {
    if (token.key === key) return token
  }

  return undefined
}

function findNestedJsonPropertyToken(text, parts) {
  const tokens = [...jsonPropertyTokens(text)]
  const stack = []

  for (const token of tokens) {
    while (stack.length > 0 && token.offset > stack.at(-1).objectEndOffset) {
      stack.pop()
    }

    const path = [...stack.map((entry) => entry.key), token.key]
    if (path.join(".") === parts.join(".")) {
      return token
    }

    const objectStartOffset = nextNonWhitespaceOffset(text, token.colonOffset + 1)
    if (text[objectStartOffset] === "{") {
      const objectEndOffset = matchingBraceOffset(text, objectStartOffset)
      if (objectEndOffset !== undefined) {
        stack.push({ key: token.key, objectEndOffset })
      }
    }
  }

  return undefined
}

function* jsonPropertyTokens(text) {
  for (const match of text.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)) {
    const keyStartOffset = match.index + 1
    const keyEndOffset = keyStartOffset + match[1].length
    yield {
      key: unescapeJsonString(match[1]),
      keyStartOffset,
      keyEndOffset,
      offset: match.index,
      colonOffset: match.index + match[0].lastIndexOf(":"),
    }
  }
}

function nextNonWhitespaceOffset(text, offset) {
  let index = offset
  while (index < text.length && /\s/.test(text[index])) index += 1
  return index
}

function matchingBraceOffset(text, openOffset) {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = openOffset; index < text.length; index += 1) {
    const character = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
    } else if (character === "{") {
      depth += 1
    } else if (character === "}") {
      depth -= 1
      if (depth === 0) return index
    }
  }

  return undefined
}

function unescapeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`)
  } catch {
    return value
  }
}

function wholeDocumentRange(text) {
  return {
    start: { line: 0, character: 0 },
    end: offsetToPosition(text, text.length),
  }
}

function normalizeSelection(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { text: "", wasQuoted: false }
  const quote = trimmed[0]
  if ((quote === "'" || quote === '"' || quote === "`") && trimmed.at(-1) === quote) {
    return { text: trimmed.slice(1, -1), wasQuoted: true }
  }
  return { text: trimmed, wasQuoted: false }
}

function messageReferenceReplacement({
  documentUri,
  text,
  range,
  messageId,
  selectedTextWasQuoted,
}) {
  const usesParaglideMessages = /\bimport\s*\{\s*m\s*\}\s*from\s*["'][^"']*paraglide\/messages["']/.test(text)
  if (!usesParaglideMessages) return `t(${JSON.stringify(messageId)})`

  const reference =
    isValidJsIdentifier(messageId) ? `m.${messageId}()` : `m[${JSON.stringify(messageId)}]()`

  if (selectedTextWasQuoted) return reference
  if (documentUri.endsWith(".svelte") && !isPositionInsideScriptTag(text, range.start)) {
    return `{${reference}}`
  }

  return reference
}

function isPositionInsideScriptTag(text, position) {
  const offset = positionToOffset(text, position)
  const before = text.slice(0, offset)
  return before.lastIndexOf("<script") > before.lastIndexOf("</script>")
}

function isValidJsIdentifier(value) {
  try {
    new Function(`const ${value} = undefined;`)
    return true
  } catch {
    return false
  }
}

export function humanMessageId(message) {
  const normalized = message
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()

  return normalized.slice(0, 48) || "message"
}

function uniqueMessageId(baseId, messages) {
  if (!messages.has(baseId)) return baseId

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseId}_${index}`
    if (!messages.has(candidate)) return candidate
  }

  return `${baseId}_${Date.now()}`
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text
}

function resolveEscapedCharacters(text) {
  return text
    .replace(/\\u([\dA-Fa-f]{4})/g, (_, group) => String.fromCodePoint(Number.parseInt(group, 16)))
    .replace(/\\[^\s]/g, "")
}

function escapeMarkdown(text) {
  return String(text).replaceAll("|", "\\|").replaceAll("\n", "<br>")
}
