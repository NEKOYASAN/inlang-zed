use zed_extension_api::{
    self as zed, settings::LspSettings, Command, LanguageServerId, Result, Worktree,
};

const SERVER_PATH: &str = "server/bin/server.js";
const SERVER_JS: &str = include_str!("../server/bin/server.js");
const CORE_JS: &str = include_str!("../server/src/core.js");
const PACKAGE_JSON: &str = r#"{"type":"module"}"#;

struct InlangZedExtension;

impl zed::Extension for InlangZedExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Command> {
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)?;
        let server_path = materialize_server()?;

        if let Some(binary) = settings.binary {
            return Ok(Command {
                command: match binary.path {
                    Some(path) => path,
                    None => zed::node_binary_path()?,
                },
                args: binary.arguments.unwrap_or_else(|| vec![server_path]),
                env: Default::default(),
            });
        }

        Ok(Command {
            command: zed::node_binary_path()?,
            args: vec![server_path],
            env: Default::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<zed_extension_api::serde_json::Value>> {
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.initialization_options)
            .unwrap_or_default();

        Ok(Some(settings))
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<zed_extension_api::serde_json::Value>> {
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.settings)
            .unwrap_or_default();

        Ok(Some(settings))
    }
}

fn materialize_server() -> Result<String> {
    let work_dir = std::env::current_dir()
        .map_err(|error| format!("failed to resolve Inlang Zed extension directory: {error}"))?;

    write_if_changed(&work_dir.join("package.json"), PACKAGE_JSON)?;
    write_if_changed(&work_dir.join("server/bin/server.js"), SERVER_JS)?;
    write_if_changed(&work_dir.join("server/src/core.js"), CORE_JS)?;

    Ok(work_dir.join(SERVER_PATH).to_string_lossy().to_string())
}

fn write_if_changed(path: &std::path::Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create Inlang Zed server directory '{}': {error}",
                parent.display()
            )
        })?;
    }

    match std::fs::read_to_string(path) {
        Ok(existing) if existing == content => return Ok(()),
        _ => {}
    }

    std::fs::write(path, content).map_err(|error| {
        format!(
            "failed to write Inlang Zed server file '{}': {error}",
            path.display()
        )
    })
}

zed::register_extension!(InlangZedExtension);
