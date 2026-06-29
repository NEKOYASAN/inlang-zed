#!/usr/bin/env node
import fs from "node:fs"
import {
  createDiagnostics,
  createDefinition,
  createExtractCodeAction,
  createHover,
  createInlayHints,
  installSyncFileReader,
  loadWorkspace,
  pathToUri,
  selectProjectForFile,
  uriToPath,
} from "../src/core.js"

installSyncFileReader(fs.readFileSync)

const documents = new Map()
let workspace
let rootPath
let initialized = false
let shutdownRequested = false
let settings = {}

process.stdin.on("data", (chunk) => readChunk(chunk))
process.stdin.resume()

let buffer = Buffer.alloc(0)

function readChunk(chunk) {
  buffer = Buffer.concat([buffer, chunk])

  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n")
    if (headerEnd === -1) return

    const headers = buffer.slice(0, headerEnd).toString("utf8")
    const lengthMatch = headers.match(/Content-Length:\s*(\d+)/i)
    if (!lengthMatch) {
      buffer = buffer.slice(headerEnd + 4)
      continue
    }

    const contentLength = Number(lengthMatch[1])
    const messageStart = headerEnd + 4
    const messageEnd = messageStart + contentLength
    if (buffer.length < messageEnd) return

    const rawMessage = buffer.slice(messageStart, messageEnd).toString("utf8")
    buffer = buffer.slice(messageEnd)
    void handleMessage(JSON.parse(rawMessage))
  }
}

async function handleMessage(message) {
  if (message.method) {
    if (Object.hasOwn(message, "id")) {
      await handleRequest(message)
    } else {
      await handleNotification(message)
    }
  }
}

async function handleRequest(message) {
  try {
    switch (message.method) {
      case "initialize":
        await initialize(message)
        break
      case "shutdown":
        shutdownRequested = true
        respond(message.id, null)
        break
      case "textDocument/hover":
        respond(message.id, await hover(message.params))
        break
      case "textDocument/definition":
        respond(message.id, await definition(message.params))
        break
      case "textDocument/inlayHint":
        respond(message.id, await inlayHint(message.params))
        break
      case "textDocument/codeAction":
        respond(message.id, await codeAction(message.params))
        break
      case "textDocument/diagnostic":
        respond(message.id, await documentDiagnostic(message.params))
        break
      case "workspace/diagnostic":
        respond(message.id, { items: [] })
        break
      default:
        respond(message.id, null)
    }
  } catch (error) {
    respondError(message.id, -32603, error instanceof Error ? error.message : String(error))
  }
}

async function handleNotification(message) {
  switch (message.method) {
    case "initialized":
      initialized = true
      break
    case "exit":
      process.exit(shutdownRequested ? 0 : 1)
      break
    case "textDocument/didOpen":
      documents.set(message.params.textDocument.uri, message.params.textDocument.text)
      await refreshWorkspace()
      await publishDiagnostics(message.params.textDocument.uri)
      break
    case "textDocument/didChange": {
      const change = message.params.contentChanges.at(-1)
      if (change && typeof change.text === "string") {
        documents.set(message.params.textDocument.uri, change.text)
        await publishDiagnostics(message.params.textDocument.uri)
      }
      break
    }
    case "textDocument/didSave":
      await refreshWorkspace()
      await publishDiagnostics(message.params.textDocument.uri)
      break
    case "textDocument/didClose":
      documents.delete(message.params.textDocument.uri)
      send("textDocument/publishDiagnostics", {
        uri: message.params.textDocument.uri,
        diagnostics: [],
      })
      break
    case "workspace/didChangeConfiguration":
    case "workspace/didChangeWatchedFiles":
      await refreshWorkspace()
      await publishAllDiagnostics()
      break
  }
}

async function initialize(message) {
  const params = message.params ?? {}
  rootPath =
    uriToPath(params.rootUri) ??
    params.rootPath ??
    uriToPath(params.workspaceFolders?.[0]?.uri)
  settings = params.initializationOptions ?? {}
  workspace = await loadWorkspace(rootPath, settings)

  respond(message.id, {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: 1,
        save: true,
      },
      hoverProvider: true,
      definitionProvider: true,
      inlayHintProvider: {
        resolveProvider: false,
      },
      codeActionProvider: {
        codeActionKinds: ["refactor.extract"],
        resolveProvider: false,
      },
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    },
    serverInfo: {
      name: "Inlang Zed",
      version: "0.1.0",
    },
  })
}

async function refreshWorkspace() {
  if (!rootPath) return
  workspace = await loadWorkspace(rootPath, settings)
}

async function hover(params) {
  const context = await documentContext(params.textDocument.uri)
  if (!context) return null
  return createHover(context.text, context.project, params.position) ?? null
}

async function definition(params) {
  const context = await documentContext(params.textDocument.uri)
  if (!context) return null
  return createDefinition(context.text, context.project, params.position) ?? null
}

async function inlayHint(params) {
  const context = await documentContext(params.textDocument.uri)
  if (!context) return []
  return createInlayHints(context.text, context.project, params.range, workspace?.settings)
}

async function codeAction(params) {
  if (!params.range) return []

  const context = await documentContext(params.textDocument.uri)
  if (!context) return []

  const action = createExtractCodeAction({
    documentUri: params.textDocument.uri,
    text: context.text,
    range: params.range,
    project: context.project,
  })

  return action ? [action] : []
}

async function publishDiagnostics(uri) {
  const context = await documentContext(uri)
  send("textDocument/publishDiagnostics", {
    uri,
    diagnostics: context ? createDiagnostics(context.text, context.project) : [],
  })
}

async function documentDiagnostic(params) {
  const context = await documentContext(params.textDocument.uri)
  return {
    kind: "full",
    items: context ? createDiagnostics(context.text, context.project) : [],
  }
}

async function publishAllDiagnostics() {
  await Promise.all([...documents.keys()].map((uri) => publishDiagnostics(uri)))
}

async function documentContext(uri) {
  const text = await documentText(uri)
  if (typeof text !== "string") return undefined

  const filePath = uriToPath(uri)
  const project = selectProject(filePath)
  if (!project) return undefined

  return { text, project }
}

async function documentText(uri) {
  if (documents.has(uri)) return documents.get(uri)

  const filePath = uriToPath(uri)
  if (!filePath) return undefined

  try {
    return await fs.promises.readFile(filePath, "utf8")
  } catch {
    return undefined
  }
}

function selectProject(filePath) {
  return selectProjectForFile(workspace?.projects ?? [], filePath)
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result })
}

function respondError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } })
}

function send(method, params) {
  if (!initialized && method !== "window/logMessage") return
  write({ jsonrpc: "2.0", method, params })
}

function write(message) {
  const json = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`)
}

process.on("uncaughtException", (error) => {
  send("window/logMessage", {
    type: 1,
    message: error instanceof Error ? error.stack || error.message : String(error),
  })
})
